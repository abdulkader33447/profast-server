const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const { getWeek } = require("date-fns");

// load env variables
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.im0knfe.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingsCollection = db.collection("trackings");
    const ridersCollection = db.collection("riders");

    //---------custom middlewares-------
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }

      // console.log("headers in middleware", req.headers);
    };

    //admin verification function
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    //---------custom middlewares-------

    //user already exists or not
    app.post("/users",  async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });

      const timeNow = new Date();
      const readableTime = timeNow.toLocaleString("en-US", {
        timeZone: "Asia/Dhaka",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      if (userExists) {
        // update last log in info
        await usersCollection.updateOne(
          { email },
          { $set: { lastLogin: readableTime } }
        );
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //get user for changing role
    app.get("/user/search", verifyFBToken, async (req, res) => {
      const emailQuery = req.query.email;
      if (!emailQuery) {
        return res.status(400).send({ message: "Missing email query" });
      }

      const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

      try {
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, created_at: 1, role: 1 })
          .limit(10)
          .toArray();
        res.send(users);
      } catch (error) {
        console.error("error searching user", error);
        res.status(500).send({ message: "Error searching users" });
      }
    });

    // Example: Express api to update user role by email
    app.patch(
      "/users/:email/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;
        const { role } = req.body;

        if (!["admin", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid role value" });
        }

        try {
          const result = await usersCollection.updateOne(
            { email },
            { $set: { role } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({ message: "User not found" });
          }

          res.send({ message: "User role updated successfully" });
        } catch (error) {
          console.error("Error updating user role:", error);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    //get users based on role
    app.get("/user/role", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        return res.status(400).send({ message: "Email query is required" });
      }

      try {
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("Error fetching role:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    

    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;

        const query = {}; // শুরুতেই খালি অবজেক্ট

        if (email) {
          query.created_by = email; // শুধু প্রপার্টি অ্যাসাইন
        }

        if (payment_status) {
          query.payment_status = payment_status;
        }

        if (delivery_status) {
          query.delivery_status = delivery_status;
        }

        const options = {
          sort: { createdAt: -1 },
        };

        console.log("parcel query", req.query, query);

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("error fetching parcels:", error);
        res.status(500).send({ message: "failed to get parcels" });
      }
    });

    //get parcels for picked up or delivery
    app.get("/rider/parcels", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).json({ message: "Rider email is required" });
        }

        const query = {
          assignedRiderEmail: email,
          delivery_status: { $in: ["rider_assigned", "in-transit"] },
        };

        const options = {
          sort: { creation_date: -1 },
        };

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.status(200).json(parcels);
      } catch (error) {
        console.error("Error fetching rider's parcels:", error);
        res.status(500).json({ message: "Failed to fetch rider parcels" });
      }
    });

    //get parcel status count by pipeline
    app.get("/parcel/delivery/status-count", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$delivery_status",
            count: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    //get rider status by pipeline
    app.get("/parcel/rider-status-count", async (req, res) => {
      const riderEmail = req.query.riderEmail;

      if (!riderEmail) {
        return res.status(400).json({ message: "Rider email is required" });
      }

      try {
        const result = await parcelsCollection
          .aggregate([
            { $match: { assignedRiderEmail: riderEmail } },
            {
              $group: {
                _id: "$delivery_status",
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                status: "$_id",
                count: 1,
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Error fetching rider status count:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    //get completed parcels based on rider
    app.get(
      "/rider/parcels/completed",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;

          if (!email) {
            return res.status(400).json({ message: "Rider email is required" });
          }

          const query = {
            assignedRiderEmail: email,
            delivery_status: { $in: ["delivered", "service_center_delivered"] },
          };

          const options = {
            sort: { creation_date: -1 },
          };

          const parcels = await parcelsCollection
            .find(query, options)
            .toArray();
          res.status(200).json(parcels);
        } catch (error) {
          console.error("Error fetching completed deliveries:", error);
          res
            .status(500)
            .json({ message: "Failed to fetch completed parcels" });
        }
      }
    );

    //add parcel data to db
    app.post("/parcels", verifyFBToken, async (req, res) => {
      try {
        const newParcel = req.body;

        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (err) {
        console.error("POST /parcels error:", err);
        res.status(500).send({ message: "Failed to save parcel" });
      }
    });

    // Assuming: parcelsCollection is your MongoDB collection
    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      try {
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({ message: "Parcel not found" });
        }

        res.json(parcel);
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    //cash out
    app.patch(
      "/parcels/:id/cashout",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const id = req.params.id;

        try {
          const parcel = await parcelsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!parcel) {
            return res.status(404).send({ message: "Parcel not found" });
          }

          if (parcel.cashout_status === "cashed_out") {
            return res.status(400).send({ message: "Already cashed out" });
          }

          const sameDistrict =
            parcel.senderRegion?.toLowerCase() ===
            parcel.receiverRegion?.toLowerCase();

          const amount = Math.round(parcel.cost * (sameDistrict ? 0.3 : 0.4));

          // Step 1: update parcel cashout
          await parcelsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                cashout_status: "cashed_out",
                cashed_out_at: new Date().toLocaleString("en-US", {
                  timeZone: "Asia/Dhaka",
                }),
              },
            }
          );

          // Step 2: update rider earnings
          await ridersCollection.updateOne(
            { email: parcel.assignedRiderEmail },
            {
              $inc: {
                pendingEarnings: -amount,
                cashedOutEarnings: amount,
              },
              $set: {
                "earningsHistory.$[elem].status": "cashed_out",
              },
            },
            {
              arrayFilters: [{ "elem.parcelId": new ObjectId(id) }],
            }
          );

          res.send({ success: true, message: "Cashout successful", amount });
        } catch (error) {
          console.error("Cashout failed:", error);
          res.status(500).send({ message: "Server error during cashout" });
        }
      }
    );

    //delete data from db
    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      if (result.deletedCount > 0) {
        res.send({ success: true });
      } else {
        res.status(404).send({ success: false, message: "Parcel not found" });
      }
    });

    //--------riders api----------
    app.post("/riders", verifyFBToken, async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // get pending riders
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.status(200).json(pendingRiders);
      } catch (error) {
        console.error("Error fetching pending riders:", error);
        res
          .status(500)
          .json({ message: "Server error fetching pending riders" });
      }
    });

    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      const { district, city } = req.query;

      const query = { status: "approved" };
      if (district) query.district = district;
      if (city) query.city = city;

      try {
        const result = await ridersCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching active riders:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // assign rider
    app.patch("/parcels/:id/assign-rider", verifyFBToken, async (req, res) => {
      const parcelId = req.params.id;
      const { riderId, riderName, riderEmail } = req.body;

      try {
        const parcelUpdateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              assignedRiderId: new ObjectId(riderId),
              assignedRiderName: riderName,
              assignedRiderEmail: riderEmail,
              riderAssignedAt: new Date().toLocaleDateString("en-GB"),
              delivery_status: "rider_assigned",
            },
          }
        );

        const riderUpdateResult = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "in-delivery",
            },
          }
        );

        res.send({
          success: true,
          parcelUpdate: parcelUpdateResult,
          riderUpdate: riderUpdateResult,
        });
      } catch (error) {
        console.error("Assign rider failed:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    //update parcels status
    app.patch("/parcels/:id/status", verifyFBToken, async (req, res) => {
      const parcelId = req.params.id;
      const { delivery_status } = req.body;

      const validStatuses = ["rider_assigned", "in-transit", "delivered"];
      if (!validStatuses.includes(delivery_status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }

      try {
        const updateDoc = {
          $set: {
            delivery_status,
            ...(delivery_status === "in-transit" && {
              pickedAt: new Date().toLocaleString(),
            }),
            ...(delivery_status === "delivered" && {
              deliveredAt: new Date().toLocaleString(),
            }),
          },
        };

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          updateDoc
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update status" });
      }
    });

    // update rider status (approved, pending, cancelled)
    app.patch(
      "/riders/:id/status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const riderId = req.params.id;
        const { status, email } = req.body;

        const validStatuses = ["approved", "pending", "inactive", "cancelled"];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ message: "Invalid status value" });
        }

        // 📌 Approve হলে approvedAt টাইমও সেট করো
        const updateFields = { status };
        if (status === "approved") {
          //update user role for accepting rider

          updateFields.approvedAt = new Date().toLocaleString("en-US", {
            timeZone: "Asia/Dhaka",
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          });
          if (email) {
            await usersCollection.updateOne(
              { email },
              { $set: { role: "rider" } }
            );
          }
        }

        try {
          const result = await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            { $set: updateFields }
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Rider not found" });
          }

          res
            .status(200)
            .json({ message: `Rider status updated to '${status}'` });
        } catch (error) {
          console.error("Error updating rider status:", error);
          res
            .status(500)
            .json({ message: "Server error while updating rider status" });
        }
      }
    );

    //---------------------------------------
    // ➕ Add rider earnings API
    app.post(
      "/rider/earnings/add",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { parcelId, email } = req.body;

        if (!email || !parcelId) {
          return res.status(400).json({ message: "Missing required fields" });
        }

        try {
          const parcel = await parcelsCollection.findOne({
            _id: new ObjectId(parcelId),
          });

          if (!parcel) {
            return res.status(404).json({ message: "Parcel not found" });
          }

          const rider = await ridersCollection.findOne({ email });

          if (!rider) {
            return res.status(404).json({ message: "Rider not found" });
          }

          // Prevent double entry
          const alreadyLogged = await ridersCollection.findOne({
            email,
            "earningsHistory.parcelId": new ObjectId(parcelId),
          });

          if (alreadyLogged) {
            return res
              .status(409)
              .json({ message: "Earnings already recorded" });
          }

          const sameDistrict = parcel.senderRegion === parcel.receiverRegion;
          const percentage = sameDistrict ? 0.3 : 0.4;
          const amount = Math.round(parcel.cost * percentage);

          const updateResult = await ridersCollection.updateOne(
            { email },
            {
              $inc: {
                totalEarnings: amount,
                pendingEarnings: amount,
              },
              $push: {
                earningsHistory: {
                  parcelId: new ObjectId(parcelId),
                  amount,
                  status: "pending",
                  date: new Date().toLocaleString(),
                },
              },
            },
            { upsert: true }
          );

          res.status(200).json({
            success: true,
            message: `Earnings (${amount}) updated successfully`,
            updateResult,
          });
        } catch (error) {
          console.error("Error updating earnings:", error);
          res.status(500).json({ message: "Failed to update earnings" });
        }
      }
    );

    //get rider earning api
    app.get("/rider/earnings", async (req, res) => {
      const email = req.query.email;

      try {
        const rider = await ridersCollection.findOne({ email });

        if (!rider) {
          return res.status(404).send({ message: "Rider not found" });
        }

        const today = new Date();
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth();
        const currentDate = today.getDate();
        const currentWeek = getWeek(today); // e.g., 27 for July 2, 2025

        const earnings = {
          total: rider.totalEarnings || 0,
          cashedOut: rider.cashedOutEarnings || 0,
          pending: rider.pendingEarnings || 0,
          today: 0,
          week: 0,
          month: 0,
          year: 0,
        };

        if (Array.isArray(rider.earningsHistory)) {
          for (const record of rider.earningsHistory) {
            const date = new Date(record.date);
            const recordYear = date.getFullYear();
            const recordMonth = date.getMonth();
            const recordDate = date.getDate();
            const recordWeek = getWeek(date);

            if (recordYear === currentYear) {
              earnings.year += record.amount;

              if (recordMonth === currentMonth) {
                earnings.month += record.amount;

                if (recordWeek === currentWeek) {
                  earnings.week += record.amount;

                  if (recordDate === currentDate) {
                    earnings.today += record.amount;
                  }
                }
              }
            }
          }
        }

        res.send(earnings);
      } catch (error) {
        console.error("Error fetching earnings:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    //tracking API
    app.post("/trackings", verifyFBToken, async (req, res) => {
      const update = req.body;

      update.timestamp = new Date();
      if (!update.tracking_id || !update.status) {
        return res
          .status(400)
          .json({ message: "tracking_id and status are required." });
      }

      // const {
      //   tracking_id,
      //   parcel_id,
      //   status,
      //   message,
      //   updated_by = "",
      // } = req.body;

      // const log = {
      //   tracking_id,
      //   parcel_id,
      //   status,
      //   message,
      //   timestamp: new Date(),
      //   updated_by,
      // };

      const result = await trackingsCollection.insertOne(update);
      res.send({ success: true, insertedId: result.insertedId });
    });

    app.get("/trackings/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      const updates = await trackingsCollection
        .find({ tracking_id: trackingId })
        .sort({ timestamp: 1 })
        .toArray();

      res.json(updates);
    });

    app.get("/payment-history", verifyFBToken, async (req, res) => {
      const { email } = req.query;

      try {
        console.log("decoded", req.decoded);

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }

        const query = email ? { userEmail: email } : {};

        const history = await paymentsCollection
          .find(query)
          .sort({ paymentTime: -1 }) // 🔽 Latest first
          .toArray();

        res.send(history);
      } catch (err) {
        console.error("Error fetching payment history:", err.message);
        res.status(500).send({ error: "Failed to fetch history" });
      }
    });

    app.post("/payments", verifyFBToken, async (req, res) => {
      const {
        parcelId,
        email,
        transactionId,
        amount,
        paymentMethod,
        paymentTime,
      } = req.body;

      try {
        // 1️⃣ Update parcel status
        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid", transactionId } }
        );

        // 2️⃣ Save to payments collection
        const paymentData = {
          parcelId: new ObjectId(parcelId),
          userEmail: email,
          transactionId,
          amount,
          paymentMethod,
          paymentTime: paymentTime || new Date(), // fallback to now
        };

        const insertResult = await paymentsCollection.insertOne(paymentData);

        res.send({
          success: true,
          message: "Payment confirmed and history saved",
          updateResult,
          insertedId: insertResult.insertedId,
        });
      } catch (err) {
        console.error("Error confirming payment:", err.message);
        res.status(500).send({ success: false, error: err.message });
      }
    });

    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents, // amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// sample route
app.get("/", (req, res) => {
  res.send("🚚 Parcel Delivery Server is Running");
});

// start server
app.listen(port, () => {
  console.log(`🚀 Server is listening at http://localhost:${port}`);
});

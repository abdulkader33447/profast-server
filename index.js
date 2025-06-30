const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

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
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking");
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
    //---------custom middlewares-------

    //get user for changing role
    app.get("/user/search", async (req, res) => {
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
    app.get("/user/role", async (req, res) => {
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

    //user already exists or not
    app.post("/users", async (req, res) => {
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

    // parcels api
    // app.get("/parcels", verifyFBToken, async (req, res) => {
    //   try {
    //     const { email } = req.query.email;

    //     // যদি email দেওয়া থাকে, created_by দিয়ে ফিল্টার করবে, না থাকলে সব দেখাবে
    //     const query = email ? { created_by: email } : {};

    //     console.log("parcel query", req.query, query);
    //     // সর্বশেষ parcel আগে দেখানোর জন্য sorted
    //     const parcels = await parcelCollection
    //       .find(query)
    //       .sort({ createdAt: -1 }) // latest first
    //       .toArray();

    //     res.status(200).json(parcels);
    //   } catch (error) {
    //     console.error("GET /parcels error:", error);
    //     res.status(500).json({ error: "Failed to get parcels" });
    //   }
    // });

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

        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("error fetching parcels:", error);
        res.status(500).send({ message: "failed to get parcels" });
      }
    });

    // sample GET route
    // app.get("/parcels", async (req, res) => {
    //   const parcels = await parcelCollection.find().toArray();
    //   res.send(parcels);
    // });

    //add parcel data to db
    app.post("/parcels", verifyFBToken, async (req, res) => {
      try {
        const newParcel = req.body;

        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (err) {
        console.error("POST /parcels error:", err);
        res.status(500).send({ message: "Failed to save parcel" });
      }
    });

    // Assuming: parcelCollection is your MongoDB collection
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const parcel = await parcelCollection.findOne({
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

    //delete data from db
    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const result = await parcelCollection.deleteOne({
        _id: new ObjectId(id),
      });

      if (result.deletedCount > 0) {
        res.send({ success: true });
      } else {
        res.status(404).send({ success: false, message: "Parcel not found" });
      }
    });

    //--------riders api----------
    app.post("/riders", async (req, res) => {
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

    //get approved riders
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await ridersCollection
        .find({ status: "approved" })
        .toArray();
      res.send(result);
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

        // if (status === " approved") {
        //   // updateFields.role = "rider";
        //   const useQuery = { email };
        //   const userUpdateDoc = {
        //     $set: {
        //       role: "rider",
        //     },
        //   };
        //   const roleResult = await usersCollection.updateOne(
        //     useQuery,
        //     userUpdateDoc
        //   );
        //   console.log(roleResult.modifiedCount);
        // }

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

    //tracking
    app.post("/tracking", async (req, res) => {
      const {
        tracking_id,
        parcel_id,
        status,
        message,
        updated_by = "",
      } = req.body;

      const log = {
        tracking_id,
        parcel_id,
        status,
        message,
        time: new Date(),
        updated_by,
      };
      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
    });

    app.get("/payment-history", verifyFBToken, async (req, res) => {
      const { email } = req.query;

      try {
        console.log("decoded", req.decoded);

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }

        const query = email ? { userEmail: email } : {};

        const history = await paymentCollection
          .find(query)
          .sort({ paymentTime: -1 }) // 🔽 Latest first
          .toArray();

        res.send(history);
      } catch (err) {
        console.error("Error fetching payment history:", err.message);
        res.status(500).send({ error: "Failed to fetch history" });
      }
    });

    app.post("/payments", async (req, res) => {
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
        const updateResult = await parcelCollection.updateOne(
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

        const insertResult = await paymentCollection.insertOne(paymentData);

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

    app.post("/create-payment-intent", async (req, res) => {
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

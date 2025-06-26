const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// load env variables
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

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
    const parcelCollection = db.collection("parcels");

    // parcels api
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;
        console.log(email);

        // যদি email দেওয়া থাকে, created_by দিয়ে ফিল্টার করবে, না থাকলে সব দেখাবে
        const query = email ? { created_by: email } : {};

        // সর্বশেষ parcel আগে দেখানোর জন্য sorted
        const parcels = await parcelCollection
          .find(query)
          .sort({ createdAt: -1 }) // latest first
          .toArray();

        res.status(200).json(parcels);
      } catch (error) {
        console.error("GET /parcels error:", error);
        res.status(500).json({ error: "Failed to get parcels" });
      }
    });

    // sample GET route
    app.get("/parcels", async (req, res) => {
      const parcels = await parcelCollection.find().toArray();
      res.send(parcels);
    });

    //add data to db
    app.post("/parcels", async (req, res) => {
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
    app.delete("/parcels/:id", async (req, res) => {
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

    app.post("/confirm-payment", async (req, res) => {
  const {
    parcelId,
    userEmail,
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
      userEmail,
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
      insertResult,
    });
  } catch (err) {
    console.error("Error confirming payment:", err.message);
    res.status(500).send({ success: false, error: err.message });
  }
});


    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents
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

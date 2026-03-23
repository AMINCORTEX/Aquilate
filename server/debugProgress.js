import mongoose from 'mongoose';
import User from './models/User.js';
import 'dotenv/config';

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const u = await User.findOne();
    if (!u) {
      console.log('No users in database');
    } else {
      console.log('Found user:');
      console.log(JSON.stringify(u.toObject(), null, 2));
    }
    process.exit(0);
  } catch (err) {
    console.error('error', err);
    process.exit(1);
  }
}

main();
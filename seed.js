/**
 * Seed script — inserts the demo login accounts.
 * Run once with:  npm run seed
 *
 * Registration has been removed from the app, so users are provisioned here.
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const User = require('./models/User');

dotenv.config();

const SEED_USERS = [
  { username: 'Fayaz', email: 'fayaz.khanxid@melf.com', password: 'King4khan' },
  { username: 'Sneha', email: 'Sneha@melf.com', password: 'Sneha@melf' },
  { username: 'Rachelle', email: 'Rachelle@melf.com', password: 'Rachelle@melf' }
];

async function seed() {
  await connectDB();
  try {
    for (const data of SEED_USERS) {
      const existing = await User.findOne({ email: data.email });
      if (existing) {
        console.log(`• User already exists: ${data.email}`);
        continue;
      }
      // The User model's pre-save hook hashes the password.
      await User.create(data);
      console.log(`✓ Created user: ${data.email}  (password: ${data.password})`);
    }
    console.log('\nSeeding complete.');
  } catch (err) {
    console.error('Seeding failed:', err.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

seed();

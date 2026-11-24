/**
 * ============================================================================
 * CLI HELPER: CONNECT & SEED MONGODB ATLAS CLUSTER
 * ============================================================================
 * Usage:
 *   node scripts/connect-atlas.js "mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority"
 *   or set MONGODB_URI in .env and run:
 *   node scripts/connect-atlas.js
 */

const { loadDatabase } = require('../backend/sheetsDb');
const { connectMongoAtlas, syncLocalToMongoAtlas } = require('../backend/mongoDb');

async function main() {
  const cliUri = process.argv[2] || null;
  const cliDbName = process.argv[3] || 'gym_manager_saas';

  console.log('====================================================================');
  console.log('🍃 CONNECTING TO MONGODB ATLAS & SEEDING 7 GYM COLLECTIONS...');
  console.log('====================================================================');

  const conn = await connectMongoAtlas(cliUri, cliDbName);
  if (!conn.ok) {
    console.error('❌ Connection Failed:', conn.error || conn.status?.lastError);
    console.log('\n👉 To connect, pass your MongoDB Atlas URI:');
    console.log('   node scripts/connect-atlas.js "mongodb+srv://<username>:<password>@<cluster>.mongodb.net/"');
    process.exit(1);
  }

  console.log(`✅ Connected to MongoDB Atlas: ${conn.status.uriMasked} (DB: ${conn.status.dbName})`);

  const db = loadDatabase();
  const syncRes = await syncLocalToMongoAtlas(db);
  if (!syncRes.ok) {
    console.error('❌ Sync Failed:', syncRes.error);
    process.exit(1);
  }

  console.log('✅ Synced all 7 Collections to MongoDB Atlas:');
  console.table(syncRes.status.collectionCounts);
  process.exit(0);
}

main();

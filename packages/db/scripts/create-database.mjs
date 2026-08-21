// Create a database if it does not exist: `node create-database.mjs <url>`.
// Connects to the server's maintenance database (`postgres`) and creates the
// database the URL's path names. Used by the v1-split rehearsal workflow
// (docs/operations/v1-split.md) to provision the per-app databases.
import pg from "pg";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: node create-database.mjs <postgres-url-with-database-path>");
  process.exit(2);
}

const url = new URL(raw);
const name = url.pathname.replace(/^\//, "");
if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
  console.error(`refusing to create database ${JSON.stringify(name)} — use a plain identifier`);
  process.exit(2);
}

const admin = new URL(raw);
admin.pathname = "/postgres";
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (exists.rowCount > 0) {
    console.log(`database "${name}" already exists`);
  } else {
    await client.query(`CREATE DATABASE "${name}"`);
    console.log(`database "${name}" created`);
  }
} finally {
  await client.end();
}

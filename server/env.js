// Loads settings before anything else. Accepts ".env" and the common mistakes
// "clearday.env" / ".env.txt" (Windows hides the extension), so a renamed download still works.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const root = process.cwd();
const candidates = ['.env', 'clearday.env', '.env.txt', 'env.txt', 'clearday.env.txt'];
const found = candidates.map(f => path.join(root, f)).find(f => fs.existsSync(f));
if (found) {
  dotenv.config({ path: found });
  if (!found.endsWith(`${path.sep}.env`)) console.log(`(Loaded settings from ${path.basename(found)} — renaming it to .env is recommended.)`);
} else {
  console.warn('\n⚠ No .env file found in ' + root + '. Copy .env.example to .env and fill it in.\n');
}

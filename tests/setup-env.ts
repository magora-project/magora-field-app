// Loads `.env.local` into process.env for Jest, when the file exists.
// `scripts/cloud-session-start.sh` writes it from the local stack; without the
// stack it is absent and this does nothing, so `npm test` never needs a backend.
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

const envFile = path.resolve(__dirname, '..', '.env.local');

if (fs.existsSync(envFile)) {
  config({ path: envFile, quiet: true });
}

import { existsSync } from "node:fs";

import { config } from "dotenv";

for (const path of [".env.local", ".env"]) {
  if (existsSync(path)) {
    config({ path, quiet: true });
  }
}

import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve from the application directory, including when opened by the desktop shortcut.
// Existing environment variables take precedence over the local file.
try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

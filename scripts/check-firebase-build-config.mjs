// Cloud Build must never silently build the browser with demo authentication.
const required = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID'];
if (
  process.env.VITE_AUTH_BACKEND !== 'firebase' ||
  required.some((key) => !process.env[key]?.trim())
) {
  console.error('Firebase web build configuration is incomplete.');
  process.exitCode = 1;
}

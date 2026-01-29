import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";

const requiredFirebaseEnvKeys = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_DATABASE_URL",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

function readFirebaseConfigFromEnv() {
  const missingKeys = requiredFirebaseEnvKeys.filter((key) => !import.meta.env[key]);
  if (missingKeys.length > 0) {
    throw new Error(
      `Missing Firebase env vars: ${missingKeys.join(", ")}. Please create .env.local from .env.example.`
    );
  }

  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
}

const app = initializeApp(readFirebaseConfigFromEnv());
export const db = getDatabase(app);
export const auth = getAuth(app);

let anonymousAuthPromise = null;

async function ensureUserToken(user, forceRefreshToken) {
  if (!user) return user;
  await user.getIdToken(!!forceRefreshToken);
  return user;
}

export function ensureAnonymousAuth(forceRefreshToken = false) {
  if (auth.currentUser) {
    return ensureUserToken(auth.currentUser, forceRefreshToken);
  }
  if (anonymousAuthPromise) return anonymousAuthPromise;

  anonymousAuthPromise = new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return;
      try {
        await ensureUserToken(user, forceRefreshToken);
        unsub();
        resolve(user);
      } catch (err) {
        unsub();
        reject(err);
      }
    });

    signInAnonymously(auth).catch((err) => {
      unsub();
      reject(err);
    });
  }).finally(() => {
    anonymousAuthPromise = null;
  });

  return anonymousAuthPromise;
}

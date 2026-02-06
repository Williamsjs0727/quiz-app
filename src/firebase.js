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

function isMissingOrPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "change_me";
}

function readFirebaseConfigFromEnv() {
  const missingKeys = requiredFirebaseEnvKeys.filter((key) => isMissingOrPlaceholder(import.meta.env[key]));

  return {
    missingKeys,
    config: {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    },
  };
}

const { missingKeys: firebaseMissingEnvKeys, config: firebaseConfig } = readFirebaseConfigFromEnv();
export { firebaseMissingEnvKeys };

export const firebaseInitErrorMessage =
  firebaseMissingEnvKeys.length > 0
    ? `Missing Firebase env vars: ${firebaseMissingEnvKeys.join(
        ", "
      )}. Please create .env.local from .env.example.`
    : "";

export const firebaseReady = firebaseMissingEnvKeys.length === 0;

const app = firebaseReady ? initializeApp(firebaseConfig) : null;
export const db = app ? getDatabase(app) : null;
export const auth = app ? getAuth(app) : null;

let anonymousAuthPromise = null;

async function ensureUserToken(user, forceRefreshToken) {
  if (!user) return user;
  await user.getIdToken(!!forceRefreshToken);
  return user;
}

export function ensureAnonymousAuth(forceRefreshToken = false) {
  if (!auth) {
    const err = new Error(firebaseInitErrorMessage || "Firebase is not configured.");
    err.code = "config/missing-firebase-env";
    return Promise.reject(err);
  }

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

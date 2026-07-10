import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getAuth } from 'firebase/auth'

const firebaseConfig = {
  apiKey: "AIzaSyB9bZTAueq8xwmQzSAhH-llHtM7lefvKYw",
  authDomain: "yezi-hub.firebaseapp.com",
  projectId: "yezi-hub",
  storageBucket: "yezi-hub.firebasestorage.app",
  messagingSenderId: "644687258733",
  appId: "1:644687258733:web:aa0bb7ee9d2263df688b64",
  measurementId: "G-0GGFSPFZ80"
}

const app = initializeApp(firebaseConfig)

export const db = getFirestore(app)
export const storage = getStorage(app)
export const auth = getAuth(app)

// The single admin account. Readers also get real Firebase Auth sessions (via
// magic link, for liking/saving guides), so "is signed in" is NOT the same as
// "is admin" — every admin-only check must compare against this email, both
// here and in firestore.rules' isAdmin().
export const ADMIN_EMAIL = 'yezi.lilyz@gmail.com'

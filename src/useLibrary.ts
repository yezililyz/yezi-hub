import { useState, useEffect, useCallback } from 'react'
import { collection, query, where, getDocsFromServer, doc, setDoc, increment, updateDoc, serverTimestamp } from 'firebase/firestore'
import type { User } from 'firebase/auth'
import { db } from './firebase'

export interface LibraryEntry { liked: boolean; saved: boolean }

// Shared by PublicHub and MyLibrary: each reader's liked/saved guides, stored
// one doc per (uid, guideId) pair at library/{uid}_{guideId}.
export function useLibrary(currentUser: User | null) {
  const [library, setLibrary] = useState<Map<string, LibraryEntry>>(new Map())
  const [loaded, setLoaded] = useState(false)

  // Wipe stale data from the previous user IMMEDIATELY (synchronously) when
  // currentUser changes — before the async query for the new user returns.
  // Without this, User A's saved guides briefly show in User B's session.
  useEffect(() => {
    setLibrary(new Map())
    setLoaded(false)
  }, [currentUser])

  const refresh = useCallback(async () => {
    if (!currentUser) { setLibrary(new Map()); setLoaded(true); return }
    // Force a server-side fetch — never serve personal library data from the
    // offline cache, which could belong to a previously logged-in account.
    const snap = await getDocsFromServer(query(collection(db, 'library'), where('uid', '==', currentUser.uid)))
    const m = new Map<string, LibraryEntry>()
    snap.docs.forEach(d => {
      const data = d.data() as any
      m.set(data.guideId, { liked: !!data.liked, saved: !!data.saved })
    })
    setLibrary(m)
    setLoaded(true)
  }, [currentUser])

  useEffect(() => { refresh() }, [refresh])

  async function setEntry(guideId: string, patch: Partial<LibraryEntry>) {
    if (!currentUser) return
    const current = library.get(guideId) ?? { liked: false, saved: false }
    const next = { ...current, ...patch }
    await setDoc(doc(db, 'library', `${currentUser.uid}_${guideId}`), {
      uid: currentUser.uid,
      guideId,
      liked: next.liked,
      saved: next.saved,
      updatedAt: serverTimestamp(),
    }, { merge: true })
    setLibrary(prev => new Map(prev).set(guideId, next))
  }

  // Returns the like-count delta (+1/-1) so the caller can optimistically
  // update its own copy of the guide's likeCount.
  async function toggleLike(guideId: string): Promise<1 | -1> {
    const wasLiked = library.get(guideId)?.liked ?? false
    await setEntry(guideId, { liked: !wasLiked })
    await updateDoc(doc(db, 'guides', guideId), { likeCount: increment(wasLiked ? -1 : 1) })
    return wasLiked ? -1 : 1
  }

  async function toggleSave(guideId: string) {
    const wasSaved = library.get(guideId)?.saved ?? false
    await setEntry(guideId, { saved: !wasSaved })
  }

  return { library, loaded, toggleLike, toggleSave, refresh }
}

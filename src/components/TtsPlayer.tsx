import { useEffect, useRef, useState } from 'react'

export interface GuideSection {
  id: string
  title: string
  text: string
}

interface TtsPlayerProps {
  sections: GuideSection[]
  lang: 'en' | 'fr'
  // Pre-generated Vapi audio URLs from Firestore (audioUrls_en / audioUrls_fr).
  // When present, <audio> plays from Firebase Storage (instant, high quality).
  // When absent, falls back to Web Speech API.
  audioUrls?: Record<string, string>
  onClose: () => void
  onSectionChange?: (sectionId: string, sectionTitle: string, index: number) => void
}

// ── Web Speech API helpers ────────────────────────────────────────────────────

function pickVoice(voices: SpeechSynthesisVoice[], lang: 'en' | 'fr'): SpeechSynthesisVoice | null {
  if (!voices.length) return null
  const primary = lang === 'fr' ? 'fr-FR' : 'en-US'
  const family  = lang === 'fr' ? 'fr'    : 'en'
  const isGood  = (v: SpeechSynthesisVoice) =>
    /marie|amelie|thomas|flo|reed|anna|samantha|karen|moira/i.test(v.name)
  const byLocale = voices.filter(v => v.lang === primary)
  const byFamily = voices.filter(v => v.lang.startsWith(family))
  return byLocale.find(isGood) || byLocale[0] || byFamily.find(isGood) || byFamily[0] || null
}

function chunkText(text: string): string[] {
  const MAX = 4500
  if (text.length <= MAX) return [text]
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text]
  const chunks: string[] = []
  let current = ''
  for (const s of sentences) {
    if ((current + s).length > MAX && current) { chunks.push(current.trim()); current = s }
    else current += s
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.length ? chunks : [text.slice(0, MAX)]
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TtsPlayer({ sections, lang, audioUrls, onClose, onSectionChange }: TtsPlayerProps) {
  const [currentIdx, setCurrentIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [paused, setPaused] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceName, setSelectedVoiceName] = useState('')
  const [showVoicePicker, setShowVoicePicker] = useState(false)

  // Refs for Web Speech fallback
  const synthRef    = useRef(window.speechSynthesis)
  const cancelRef   = useRef(false)
  const voicesRef   = useRef<SpeechSynthesisVoice[]>([])

  // <audio> element ref for Vapi-cached playback
  const audioRef    = useRef<HTMLAudioElement | null>(null)

  const hasVapi = (idx: number) => !!(audioUrls && audioUrls[sections[idx]?.id])

  // ── Voice loading (Web Speech fallback only) ─────────────────────────────
  useEffect(() => {
    function load() {
      const all = synthRef.current.getVoices()
      if (!all.length) return
      voicesRef.current = all
      setVoices(all)
      const best = pickVoice(all, lang)
      if (best) setSelectedVoiceName(best.name)
    }
    load()
    synthRef.current.onvoiceschanged = load
    return () => { synthRef.current.onvoiceschanged = null }
  }, [lang])

  const langFamily = lang === 'fr' ? 'fr' : 'en'
  const langVoices = voices.filter(v => v.lang.startsWith(langFamily))

  function getActiveVoice() {
    if (selectedVoiceName) {
      const named = voicesRef.current.find(v => v.name === selectedVoiceName)
      if (named) return named
    }
    return pickVoice(voicesRef.current, lang)
  }

  // ── Vapi audio playback path ─────────────────────────────────────────────
  function playVapiSection(idx: number) {
    const url = audioUrls![sections[idx].id]
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }
    const audio = new Audio(url)
    audioRef.current = audio
    cancelRef.current = false
    setCurrentIdx(idx)
    setPlaying(true)
    setPaused(false)
    onSectionChange?.(sections[idx].id, sections[idx].title, idx)

    audio.onended = () => {
      if (!cancelRef.current) goToSection(idx + 1)
    }
    audio.onerror = () => {
      console.warn('Audio load error, falling back to speech synthesis for this section')
      if (!cancelRef.current) speakSectionWSAPI(idx)
    }
    audio.play().catch(() => {
      if (!cancelRef.current) speakSectionWSAPI(idx)
    })
  }

  // ── Web Speech fallback path ─────────────────────────────────────────────
  function speakSectionWSAPI(idx: number) {
    const synth  = synthRef.current
    const voice  = getActiveVoice()
    const chunks = chunkText(sections[idx].text)
    let ci = 0

    cancelRef.current = false
    setCurrentIdx(idx)
    setPlaying(true)
    setPaused(false)
    onSectionChange?.(sections[idx].id, sections[idx].title, idx)

    function speakChunk() {
      if (cancelRef.current || ci >= chunks.length) {
        if (!cancelRef.current) goToSection(idx + 1)
        return
      }
      const u = new SpeechSynthesisUtterance(chunks[ci])
      u.lang  = lang === 'fr' ? 'fr-FR' : 'en-US'
      u.rate  = 0.95
      if (voice) u.voice = voice
      u.onend  = () => { if (!cancelRef.current) { ci++; speakChunk() } }
      u.onerror = () => { if (!cancelRef.current) goToSection(idx + 1) }
      synth.speak(u)
    }
    speakChunk()
  }

  // ── Unified section navigation ────────────────────────────────────────────
  function goToSection(idx: number) {
    if (idx < 0 || idx >= sections.length) { setPlaying(false); setPaused(false); return }
    stopAll()
    if (hasVapi(idx)) playVapiSection(idx)
    else {
      synth_cancel()
      setTimeout(() => speakSectionWSAPI(idx), 20)
    }
  }

  function stopAll() {
    cancelRef.current = true
    synthRef.current.cancel()
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = '' }
  }

  function synth_cancel() {
    cancelRef.current = true
    synthRef.current.cancel()
  }

  // Start on mount (80ms delay satisfies Safari user-gesture requirement)
  useEffect(() => {
    const t = setTimeout(() => goToSection(0), 80)
    return () => { clearTimeout(t); stopAll() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Controls ─────────────────────────────────────────────────────────────
  function handlePlay() {
    if (paused) {
      if (audioRef.current) { audioRef.current.play(); setPaused(false); setPlaying(true) }
      else { synthRef.current.resume(); setPaused(false); setPlaying(true) }
    } else {
      goToSection(currentIdx)
    }
  }

  function handlePause() {
    if (audioRef.current) audioRef.current.pause()
    else synthRef.current.pause()
    setPaused(true)
    setPlaying(false)
  }

  function handleStop() { stopAll(); onClose() }
  function handlePrev() { stopAll(); goToSection(Math.max(0, currentIdx - 1)) }
  function handleNext() { stopAll(); goToSection(Math.min(sections.length - 1, currentIdx + 1)) }
  function jumpTo(i: number) { stopAll(); goToSection(i) }

  const sec      = sections[currentIdx]
  const pct      = sections.length > 1 ? (currentIdx / (sections.length - 1)) * 100 : 100
  const usingVapi = hasVapi(currentIdx)

  return (
    <div className="tts-bar">
      <div className="tts-sections">
        {sections.map((s, i) => (
          <button key={s.id} className={`tts-sec-item ${i === currentIdx ? 'active' : ''}`} onClick={() => jumpTo(i)}>
            {hasVapi(i) && <span className="tts-sec-dot" title="High-quality audio ready" />}
            {i + 1}. {s.title}
          </button>
        ))}
      </div>

      <div className="tts-controls">
        <div className="tts-controls-inner">
          <button className="tts-btn" onClick={handlePrev} disabled={currentIdx === 0}>⏮</button>
          {playing
            ? <button className="tts-btn tts-btn-primary" onClick={handlePause}>⏸</button>
            : <button className="tts-btn tts-btn-primary" onClick={handlePlay}>▶</button>}
          <button className="tts-btn" onClick={handleNext} disabled={currentIdx === sections.length - 1}>⏭</button>
        </div>

        <div className="tts-info">
          {/* Voice picker — only shown in Web Speech fallback mode */}
          {!usingVapi && (
            <div style={{ position: 'relative' }}>
              <button className="tts-voice-btn" onClick={() => setShowVoicePicker(v => !v)}>
                🔊 {selectedVoiceName || (lang === 'fr' ? 'Voix' : 'Voice')}
              </button>
              {showVoicePicker && langVoices.length > 0 && (
                <div className="tts-voice-picker">
                  <div className="tts-voice-label">{lang === 'fr' ? 'Choisir une voix' : 'Choose a voice'}</div>
                  {langVoices.map(v => (
                    <button
                      key={v.name}
                      className={`tts-voice-option ${v.name === selectedVoiceName ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedVoiceName(v.name)
                        setShowVoicePicker(false)
                        cancelRef.current = true
                        setTimeout(() => speakSectionWSAPI(currentIdx), 50)
                      }}
                    >
                      {v.name}<span className="tts-voice-locale">{v.lang}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Vapi quality badge */}
          {usingVapi && (
            <span className="tts-quality-badge">✦ Vapi</span>
          )}

          <div className="tts-track">
            <div className="tts-progress" style={{ width: `${pct}%` }} />
          </div>
          <span className="tts-counter">{currentIdx + 1} / {sections.length}</span>
          <span className="tts-title">{sec?.title}</span>
        </div>

        <button className="tts-close" onClick={handleStop}>✕</button>
      </div>
    </div>
  )
}

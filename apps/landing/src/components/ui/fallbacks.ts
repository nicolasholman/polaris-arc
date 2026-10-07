/**
 * The gradients each image slot shows while its file is missing, in the
 * palette of the section it sits in.
 */
export const fallbacks = {
  hero: [
    "radial-gradient(38% 52% at 58% 40%, rgba(214,178,132,0.55) 0%, rgba(150,118,80,0.25) 45%, transparent 75%)",
    "radial-gradient(30% 40% at 60% 88%, rgba(196,186,160,0.35) 0%, transparent 70%)",
    "radial-gradient(45% 60% at 88% 30%, rgba(40,52,38,0.9) 0%, transparent 70%)",
    "linear-gradient(120deg, #3b3022 0%, #231d15 38%, #1a1c14 70%, #141712 100%)",
  ].join(", "),
  phone: [
    "radial-gradient(22% 30% at 56% 36%, rgba(226,186,150,0.85) 0%, rgba(200,150,110,0.35) 55%, transparent 80%)",
    "radial-gradient(38% 42% at 54% 92%, rgba(40,62,40,0.95) 0%, rgba(40,62,40,0.5) 50%, transparent 80%)",
    "radial-gradient(26% 40% at 88% 22%, rgba(168,112,72,0.7) 0%, transparent 75%)",
    "radial-gradient(30% 40% at 10% 55%, rgba(92,128,78,0.55) 0%, transparent 75%)",
    "linear-gradient(165deg, #b9ab94 0%, #9a8b73 34%, #6f6450 66%, #3f3a2e 100%)",
  ].join(", "),
  testimonial: [
    "radial-gradient(26% 44% at 60% 34%, rgba(232,196,168,0.85) 0%, rgba(214,170,120,0.35) 50%, transparent 75%)",
    "radial-gradient(34% 50% at 14% 40%, rgba(112,160,82,0.75) 0%, transparent 70%)",
    "radial-gradient(40% 40% at 66% 92%, rgba(34,60,40,0.9) 0%, transparent 70%)",
    "linear-gradient(180deg, #c4cabb 0%, #8fa287 45%, #4d6a4a 75%, #2c4230 100%)",
  ].join(", "),
  articles: [
    [
      "radial-gradient(40% 50% at 70% 72%, rgba(226,196,170,0.9) 0%, transparent 70%)",
      "radial-gradient(40% 60% at 12% 70%, rgba(62,102,58,0.9) 0%, transparent 70%)",
      "linear-gradient(160deg, #8fb5b8 0%, #b7c7c2 32%, #9c8468 70%, #6a5842 100%)",
    ].join(", "),
    [
      "radial-gradient(28% 50% at 48% 32%, rgba(120,170,70,0.85) 0%, transparent 70%)",
      "radial-gradient(40% 40% at 75% 60%, rgba(236,226,206,0.8) 0%, transparent 70%)",
      "linear-gradient(170deg, #e2d6b8 0%, #a89a74 40%, #5e5236 75%, #3a3322 100%)",
    ].join(", "),
    [
      "radial-gradient(30% 50% at 38% 55%, rgba(176,146,92,0.8) 0%, transparent 70%)",
      "radial-gradient(40% 60% at 85% 20%, rgba(96,140,84,0.8) 0%, transparent 70%)",
      "linear-gradient(170deg, #b8ccb4 0%, #8fb0a2 40%, #6f7f5e 75%, #4c5840 100%)",
    ].join(", "),
  ],
  avatars: [
    "radial-gradient(60% 60% at 40% 35%, #f0d7bd 0%, #c49a78 60%, #7c5a40 100%)",
    "radial-gradient(60% 60% at 45% 35%, #d9c3a8 0%, #6d5842 60%, #2e2419 100%)",
    "radial-gradient(60% 60% at 45% 35%, #c9d8b8 0%, #6f8a52 60%, #34471f 100%)",
  ],
} as const;

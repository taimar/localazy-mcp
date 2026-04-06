export const CHARACTER_LIMIT = Math.max(
  1000,
  parseInt(process.env.LOCALAZY_CHARACTER_LIMIT ?? "50000", 10) || 50000,
);

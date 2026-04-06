export const CHARACTER_LIMIT = Math.max(
  1000,
  parseInt(process.env.LOCALAZY_CHARACTER_LIMIT ?? "25000", 10) || 25000,
);

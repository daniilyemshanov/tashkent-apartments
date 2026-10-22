export function throwOnSupabaseError(operation, error) {
  if (!error) return;
  console.error(`Supabase (${operation}) error:`, error.message);
  throw new Error(`Supabase (${operation}) failed: ${error.message}`);
}

// Supabase caps a single request at ~1000 rows by default. Any list that can grow
// past 1000 must be paged through, or counts/displays silently undercount.
//
// Pass a factory that applies .range(from, to) to your fully-built query — all
// selects, filters, joins and ordering are preserved. Pages until a short page
// signals the end. Harmless for small tables (returns in a single page).
//
//   const units = await fetchAllRows<Row>((from, to) =>
//     supabase.from('packed_units').select('sku, status').range(from, to))
export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery(from, from + pageSize - 1)
    if (error) break
    const batch = data || []
    all.push(...batch)
    if (batch.length < pageSize) break
  }
  return all
}

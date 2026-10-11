import { supabase } from './_supabase.js';
import { requireAuth } from './_auth.js';

// Раньше цифры в шапке ("Всего в базе", "Сегодня" и т.д.) считались на
// фронтенде из уже загруженного массива объявлений — то есть были
// корректны только в рамках того, что успело прилететь по текущим
// фильтрам/дальности. Теперь лента подгружается страницами (см.
// listings.js), поэтому считать статистику из неё же больше нельзя —
// вместо этого отдельные быстрые COUNT-запросы к Supabase (head:true —
// эти строки вообще не передаются, только число).

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const email = await requireAuth(req, res);
  if (!email) return;

  const daysParam = req.query.days;
  const days = daysParam === 'all' ? null : Number(daysParam) || 3;

  function base() {
    let query = supabase.from('listings').select('*', { count: 'exact', head: true });
    if (days !== null) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte('created_at', cutoff);
    }
    if (req.query.showAgents !== 'true') {
      query = query.neq('label_kind', 'agent').neq('flagged_agent', true);
    }
    query = query.neq('is_duplicate', true);
    return query;
  }

  const todayCutoff = new Date();
  todayCutoff.setHours(0, 0, 0, 0);

  try {
    const [totalRes, todayRes, ownersRes, notContactedRes] = await Promise.all([
      base(),
      base().gte('created_at', todayCutoff.toISOString()),
      base().in('label_kind', ['owner', 'unchecked']),
      base().neq('contacted', true),
    ]);
    for (const r of [totalRes, todayRes, ownersRes, notContactedRes]) {
      if (r.error) throw new Error(r.error.message);
    }
    res.status(200).json({
      total: totalRes.count ?? 0,
      today: todayRes.count ?? 0,
      owners: ownersRes.count ?? 0,
      notContacted: notContactedRes.count ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

import { useEffect, useState, useCallback, useRef, memo } from 'react';
import { supabase, supabaseConfigMissing } from './lib/supabaseClient.js';
import { DISTRICTS } from './districts.js';

const REFRESH_MS = 20000;
const PAGE_SIZE = 30;
const DEBOUNCE_MS = 350;

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

function badgeFor(listing) {
  if (listing.label_kind === 'owner') return { cls: 'badge-owner', text: '✓ Собственник' };
  if (listing.label_kind === 'unchecked') return { cls: 'badge-owner', text: `✓ ${listing.label_text || 'Скорее всего собственник'}` };
  if (listing.label_kind === 'agent') return { cls: 'badge-agent', text: `${listing.label_text || 'Агентство'}` };
  return { cls: 'badge-unsure', text: 'Сомнительно' };
}

function dealTag(dealType) {
  if (dealType === 'sale') return <span className="deal-tag deal-sale">Продажа</span>;
  if (dealType === 'rent') return <span className="deal-tag deal-rent">Аренда</span>;
  return null;
}

function propertyTypeLabel(propertyType) {
  if (propertyType === 'house') return 'Дом';
  if (propertyType === 'commercial') return 'Коммерция';
  return 'Квартира';
}

// email → компактное имя для отображения на карточке ("ivan@..." → "ivan")
function shortAssignee(v) {
  if (!v) return '';
  return v.includes('@') ? v.split('@')[0] : v;
}

// OLX иногда протекает CSS-in-JS текстом прямо в описание — в базе
// уже есть старые записи с ".css-1f8vyal{...}" внутри raw_text
// (сам источник бага починен в scraper/src/scrapers/olx.js, но это
// не переписывает задним числом то, что уже сохранено). Чистим на
// отображении, чтобы старые карточки не редеплоить/не пересобирать
// заново — режем куски вида ".css-xxxxx{...}" и обрывки CSS-переменных
// вроде "var(--fontSizeHeadlineLarge, 24px)", которые остаются от
// обрезанного посередине CSS-правила.
function stripCssGarbage(text) {
  return text
    .replace(/^\s*Описание\s*/i, '')
    .replace(/\.css-[\w-]+\s*\{[^{}]*\}?/g, ' ')
    .replace(/[\w-]*\{[^{}]*--[\w-]+[^{}]*\}?/g, ' ')
    .replace(/var\(--[\w-]+(?:,[^)]*)?\)?/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// raw_text — это "заголовок\nописание"; показываем только то, что после
// заголовка, и обрезаем — на карточке это просто краткая выдержка, а не
// полный текст объявления.
function descriptionExcerpt(listing) {
  if (!listing.raw_text) return null;
  let text = listing.raw_text;
  if (listing.title && text.startsWith(listing.title)) {
    text = text.slice(listing.title.length);
  }
  text = stripCssGarbage(text.replace(/\s+/g, ' ')).trim();
  if (!text) return null;
  return text.length > 170 ? `${text.slice(0, 170).trim()}…` : text;
}

// ---------- Выпадающий мультивыбор районов ----------

function DistrictFilter({ selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const toggleDistrict = (d) => {
    onChange(selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d]);
  };

  const label =
    selected.length === 0 ? 'Все районы' : selected.length === 1 ? selected[0] : `Районы: ${selected.length}`;

  return (
    <div className="district-filter" ref={ref}>
      <button
        type="button"
        className={`btn district-toggle ${selected.length ? 'is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <div className="district-menu">
          {DISTRICTS.map((d) => (
            <label key={d} className="district-option">
              <input type="checkbox" checked={selected.includes(d)} onChange={() => toggleDistrict(d)} />
              {d}
            </label>
          ))}
          {selected.length > 0 && (
            <button type="button" className="btn btn-small district-clear" onClick={() => onChange([])}>
              Сбросить район
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Мультивыбор комнат (тот же паттерн, что и DistrictFilter
// выше — по просьбе Владика 24.08.2026, "как по районам") ----------

const ROOMS_OPTIONS = [
  { value: '1', label: '1 комната' },
  { value: '2', label: '2 комнаты' },
  { value: '3', label: '3 комнаты' },
  { value: '4', label: '4 комнаты' },
  { value: '5plus', label: '5+ комнат' },
];

function RoomsFilter({ selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const toggleRoom = (v) => {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };

  const label =
    selected.length === 0
      ? 'Любая комнатность'
      : selected.length === 1
        ? ROOMS_OPTIONS.find((o) => o.value === selected[0])?.label || selected[0]
        : `Комнат: ${selected.map((v) => (v === '5plus' ? '5+' : v)).join(', ')}`;

  return (
    <div className="district-filter" ref={ref}>
      <button
        type="button"
        className={`btn district-toggle ${selected.length ? 'is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <div className="district-menu">
          {ROOMS_OPTIONS.map((o) => (
            <label key={o.value} className="district-option">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggleRoom(o.value)} />
              {o.label}
            </label>
          ))}
          {selected.length > 0 && (
            <button type="button" className="btn btn-small district-clear" onClick={() => onChange([])}>
              Сбросить комнаты
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Карточка объявления ----------

const Card = memo(function Card({ listing, selected, myEmail, onToggleContacted, onToggleSelect, onSaveNote, onAssign }) {
  const badge = badgeFor(listing);
  const isOwner = listing.label_kind === 'owner' || listing.label_kind === 'unchecked';
  const isMine = listing.assigned_to === myEmail;
  const assignedToOther = listing.assigned_to && !isMine;

  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(listing.notes || '');
  const excerpt = descriptionExcerpt(listing);
  const [imgFailed, setImgFailed] = useState(false);

  // Если заметку поменяли где-то ещё (Telegram / другой человек) и мы
  // сейчас её не редактируем — подхватываем новое значение.
  useEffect(() => {
    if (!editingNote) setNoteDraft(listing.notes || '');
  }, [listing.notes, editingNote]);

  const saveNote = () => {
    setEditingNote(false);
    const trimmed = noteDraft.trim();
    if (trimmed !== (listing.notes || '')) onSaveNote(listing.id, trimmed);
  };

  return (
    <div className={`card ${listing.contacted ? 'is-contacted' : ''} ${isOwner ? 'is-owner' : ''} ${selected ? 'is-selected' : ''}`}>
      <div className="card-top">
        <input
          type="checkbox"
          className="card-select"
          checked={selected}
          onChange={() => onToggleSelect(listing.id)}
          aria-label="Выбрать объявление"
        />
        {listing.image_url && !imgFailed && (
          <img
            className="card-thumb"
            src={listing.image_url}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        )}
        <div className="card-main">
          <p className="card-title">
            <a href={listing.url} target="_blank" rel="noreferrer">{listing.title}</a>
          </p>
          <p className="card-meta">
            {dealTag(listing.deal_type)}
            <span className="source-tag">{propertyTypeLabel(listing.property_type)}</span>
            <span className="source-tag">{listing.source}</span>
            &nbsp;·&nbsp;{timeAgo(listing.created_at)}
            {listing.district ? ` · ${listing.district}` : ''}
            {listing.assigned_to ? ` · Взял: ${shortAssignee(listing.assigned_to)}` : ''}
          </p>
          {excerpt && <p className="card-excerpt">{excerpt}</p>}
          {editingNote ? (
            <input
              autoFocus
              className="note-input"
              value={noteDraft}
              maxLength={500}
              placeholder="Заметка — например, перезвонить завтра"
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={saveNote}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveNote();
                if (e.key === 'Escape') { setNoteDraft(listing.notes || ''); setEditingNote(false); }
              }}
            />
          ) : listing.notes ? (
            <p className="note-line" onClick={() => setEditingNote(true)} title="Нажмите, чтобы изменить">
              📝 {listing.notes}
            </p>
          ) : null}
        </div>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="card-bottom">
        <span className="price">{listing.price || 'цена не указана'}</span>
        <div className="card-actions">
          {!listing.notes && !editingNote && (
            <button className="btn" onClick={() => setEditingNote(true)}>+ Заметка</button>
          )}
          <button
            className={`btn ${isMine ? 'is-on btn-contact' : ''}`}
            disabled={assignedToOther}
            title={assignedToOther ? `Уже взял в работу: ${listing.assigned_to}` : undefined}
            onClick={() => onAssign(listing.id)}
          >
            {isMine ? '↩️ Освободить' : assignedToOther ? `Взял: ${shortAssignee(listing.assigned_to)}` : 'Взять в работу'}
          </button>
          <button
            className={`btn btn-contact ${listing.contacted ? 'is-on' : ''}`}
            onClick={() => onToggleContacted(listing.id, !listing.contacted)}
          >
            {listing.contacted ? '✓ Связались' : 'Отметить связь'}
          </button>
          {listing.phone && (
            <>
              <a className="btn" href={`https://wa.me/${listing.phone.replace(/[^\d]/g, '')}`} target="_blank" rel="noreferrer">WhatsApp</a>
              <a className="btn" href={`tel:${listing.phone}`}>Позвонить</a>
            </>
          )}
          <a className="btn btn-primary" href={listing.url} target="_blank" rel="noreferrer">Открыть</a>
        </div>
      </div>
    </div>
  );
});

function CardSkeleton() {
  return (
    <div className="card card-skeleton">
      <div className="skel-line skel-title" />
      <div className="skel-line skel-meta" />
      <div className="skel-line skel-bottom" />
    </div>
  );
}

// ---------- Экран входа ----------

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const sendLink = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setSent(true);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="eyebrow">Ташкент · недвижимость</div>
        <h1>Вход в систему</h1>
        {sent ? (
          <p className="auth-hint">
            Ссылка для входа отправлена на <b>{email}</b>. Откройте почту и перейдите по ссылке —
            вернётесь сюда уже авторизованным.
          </p>
        ) : (
          <form onSubmit={sendLink}>
            <input
              type="email"
              required
              placeholder="ваш email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? 'Отправляю…' : 'Получить ссылку для входа'}
            </button>
            {error && <p className="auth-error">{error}</p>}
          </form>
        )}
        <p className="auth-footnote">
          Доступ есть только у приглашённых. Если вас ещё не добавили — попросите
          кого-то из команды пригласить ваш email.
        </p>
      </div>
    </div>
  );
}

function NotAuthorizedScreen({ email, onSignOut }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="eyebrow">Ташкент · недвижимость</div>
        <h1>Нет доступа</h1>
        <p className="auth-hint">
          Вы вошли как <b>{email}</b>, но этого email нет в списке команды.
          Попросите кого-то, у кого уже есть доступ, пригласить вас.
        </p>
        <button className="btn" onClick={onSignOut}>Выйти</button>
      </div>
    </div>
  );
}

// ---------- Панель команды ----------

function TeamPanel({ authFetch, myEmail: myEmailRaw, onClose }) {
  const myEmail = (myEmailRaw || '').toLowerCase();
  const [members, setMembers] = useState([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('admin');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    const res = await authFetch('/api/team');
    if (res?.ok) setMembers(await res.json());
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const myRole = members.find((m) => m.email === myEmail)?.role;
  const iAmOwner = myRole === 'owner';
  const ownerCount = members.filter((m) => m.role === 'owner').length;

  const invite = async (e) => {
    e.preventDefault();
    setStatus('Приглашаю…');
    const res = await authFetch('/api/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail.trim(), role: newRole }),
    });
    if (res?.ok) {
      setStatus('Готово ✓');
      setNewEmail('');
      setNewRole('admin');
      load();
    } else {
      setStatus('Не получилось — проверьте email');
    }
  };

  const changeRole = async (email, role) => {
    setStatus('Меняю роль…');
    const res = await authFetch('/api/team', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    if (res?.ok) {
      setStatus('Готово ✓');
      load();
    } else {
      const body = await res?.json().catch(() => null);
      setStatus(body?.error || 'Не получилось сменить роль');
    }
  };

  const removeMember = async (email) => {
    if (!window.confirm(`Убрать ${email} из команды?`)) return;
    setStatus('Удаляю…');
    const res = await authFetch('/api/team', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (res?.ok) {
      setStatus('Готово ✓');
      load();
    } else {
      const body = await res?.json().catch(() => null);
      setStatus(body?.error || 'Не получилось удалить');
    }
  };

  return (
    <div className="team-panel">
      <div className="team-panel-header">
        <h3>Команда</h3>
        <button className="btn" onClick={onClose}>Закрыть</button>
      </div>
      <ul className="team-list">
        {members.map((m) => {
          const isLastOwner = m.role === 'owner' && ownerCount <= 1;
          return (
            <li key={m.email} className="team-list-row">
              <span>
                {m.email} {m.email === myEmail && <span className="you-tag">это вы</span>}
              </span>
              <span className="team-list-row-right">
                <span className={`role-badge role-badge-${m.role}`}>
                  {m.role === 'owner' ? 'владелец' : 'админ'}
                </span>
                {iAmOwner && (
                  <>
                    {m.role === 'admin' ? (
                      <button className="btn btn-small" onClick={() => changeRole(m.email, 'owner')}>
                        Сделать владельцем
                      </button>
                    ) : (
                      <button
                        className="btn btn-small"
                        disabled={isLastOwner}
                        title={isLastOwner ? 'Нельзя — это последний владелец' : undefined}
                        onClick={() => changeRole(m.email, 'admin')}
                      >
                        Сделать админом
                      </button>
                    )}
                    <button
                      className="btn btn-small btn-danger"
                      disabled={isLastOwner}
                      title={isLastOwner ? 'Нельзя — это последний владелец' : undefined}
                      onClick={() => removeMember(m.email)}
                    >
                      Убрать
                    </button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {iAmOwner && (
        <form onSubmit={invite} className="team-invite-form">
          <input
            type="email"
            required
            placeholder="email нового человека"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
            <option value="admin">Админ</option>
            <option value="owner">Владелец</option>
          </select>
          <button className="btn btn-primary" type="submit">Пригласить</button>
        </form>
      )}
      {status && <p className="auth-hint">{status}</p>}
    </div>
  );
}

// ---------- Основной дашборд ----------

export default function App() {
  if (supabaseConfigMissing) {
    return (
      <div className="config-error">
        <h2>⚠️ Сайт не настроен</h2>
        <p>
          Не заданы переменные окружения <code>VITE_SUPABASE_URL</code> и{' '}
          <code>VITE_SUPABASE_ANON_KEY</code>.
        </p>
        <p>
          В Vercel: Project Settings → Environment Variables — добавьте обе,
          затем сделайте <b>Redeploy</b> (одного добавления переменной
          недостаточно, нужна пересборка). Значения — в Supabase → Project
          Settings → API Keys (anon public ключ).
        </p>
      </div>
    );
  }

  return <Dashboard />;
}

function Dashboard() {
  const [session, setSession] = useState(undefined);
  const [authorized, setAuthorized] = useState(null);
  const [showTeam, setShowTeam] = useState(false);

  const [items, setItems] = useState([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusText, setStatusText] = useState('Загрузка…');
  const [stats, setStats] = useState({ total: 0, today: 0, owners: 0, notContacted: 0 });

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [dealFilter, setDealFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [roomsFilter, setRoomsFilter] = useState([]);
  const [areaMinInput, setAreaMinInput] = useState('');
  const [areaMaxInput, setAreaMaxInput] = useState('');
  const [areaMin, setAreaMin] = useState('');
  const [areaMax, setAreaMax] = useState('');
  const [badgeFilter, setBadgeFilter] = useState('all');
  const [contactedFilter, setContactedFilter] = useState('all');
  const [daysRange, setDaysRange] = useState('3');
  const [districtFilter, setDistrictFilter] = useState([]);
  const [sortBy, setSortBy] = useState('new');
  const [priceCurrency, setPriceCurrency] = useState('all');
  const [priceMinInput, setPriceMinInput] = useState('');
  const [priceMaxInput, setPriceMaxInput] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [assignedFilter, setAssignedFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkWorking, setBulkWorking] = useState(false);

  // ИИ-поиск (client/api/ai-search.js) — отдельное состояние, НЕ трогает
  // обычный searchInput. Эндпоинт только переводит текст в те же фильтры,
  // что ниже (districtFilter/dealFilter/...) — сам поиск как и раньше
  // делает listings.js через buildListingsUrl.
  const [aiQuery, setAiQuery] = useState('');
  const [aiSearching, setAiSearching] = useState(false);
  const [aiError, setAiError] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Комнатность не применима к коммерции — если переключились на неё
  // (руками или через ИИ-поиск), снимаем ранее выбранный rooms-фильтр,
  // а не оставляем его тихо висеть в URL за скрытым селектом. И наоборот:
  // площадь актуальна только для коммерции — сбрасываем её при уходе
  // с коммерции по той же причине.
  useEffect(() => {
    if (typeFilter === 'commercial' && roomsFilter.length > 0) setRoomsFilter([]);
    if (typeFilter !== 'commercial' && (areaMinInput || areaMaxInput)) {
      setAreaMinInput('');
      setAreaMaxInput('');
    }
  }, [typeFilter, roomsFilter, areaMinInput, areaMaxInput]);

  useEffect(() => {
    const id = setTimeout(() => {
      setPriceMin(priceMinInput);
      setPriceMax(priceMaxInput);
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [priceMinInput, priceMaxInput]);

  useEffect(() => {
    const id = setTimeout(() => {
      setAreaMin(areaMinInput);
      setAreaMax(areaMaxInput);
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [areaMinInput, areaMaxInput]);

  const authFetch = useCallback(
    async (url, options = {}) => {
      if (!session?.access_token) return null;

      const doFetch = (token) =>
        fetch(url, {
          ...options,
          headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`,
          },
        });

      let res = await doFetch(session.access_token);

      if (res.status === 401) {
        // Токен мог протухнуть, пока вкладка была в фоне (браузеры тормозят
        // таймер автообновления supabase-js в неактивных вкладках) — сам
        // клиент этого не заметил и продолжал слать старый access_token.
        // Прежде чем сдаваться и показывать "не авторизован", пробуем
        // принудительно обновить сессию и повторить запрос один раз.
        const { data, error } = await supabase.auth.refreshSession();
        if (!error && data?.session?.access_token) {
          res = await doFetch(data.session.access_token);
        }
      }

      if (res.status === 401) {
        setAuthorized(false);
        return null;
      }
      setAuthorized(true);
      return res;
    },
    [session]
  );

  // Применяет ответ ai-search.js к уже существующим фильтрам — сам
  // запрос объявлений (buildListingsUrl/listings.js) ничего об этом
  // не знает, просто увидит новые значения state на следующий рендер,
  // как при обычном ручном выборе фильтров.
  const runAiSearch = useCallback(async () => {
    const text = aiQuery.trim();
    if (!text) return;

    setAiSearching(true);
    setAiError('');
    try {
      const res = await authFetch('/api/ai-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res) return; // authFetch уже сам обработал 401

      if (!res.ok) {
        // Раньше судили по голому res.status (только 503 vs всё
        // остальное) — из-за этого ЛЮБОЙ временный сбой Gemini (503
        // "перегружен", таймаут, 5xx) показывался пользователю как
        // "попробуйте переформулировать", хотя дело вообще не в тексте
        // запроса. Теперь читаем reason прямо из тела ответа (см.
        // ai-search.js) — он точнее статус-кода.
        let reason = null;
        try {
          const body = await res.json();
          reason = body?.reason;
        } catch {
          // тело не JSON или пустое — не критично, ниже сработает
          // общий текст по умолчанию
        }
        setAiError(
          reason === 'unavailable'
            ? 'ИИ-поиск не настроен (нет GEMINI_API_KEY на сервере)'
            : reason === 'unparseable'
              ? 'Не получилось распознать запрос — попробуйте переформулировать'
              : reason === 'fallback_exhausted'
                ? 'ИИ-поиск не смог ответить ни через одного провайдера — попробуйте позже'
              : 'ИИ-поиск сейчас перегружен или недоступен — попробуйте через минуту'
        );
        return;
      }

      const r = await res.json();

      setDistrictFilter(r.district || []);
      setDealFilter(r.deal || 'all');
      setTypeFilter(r.type || 'all');
      setRoomsFilter(Array.isArray(r.rooms) ? r.rooms.map(String) : []);
      setBadgeFilter(r.badge || 'all');
      setPriceCurrency(r.currency || 'all');

      // Ставим сразу и *Input, и дебounced-версию — иначе пришлось бы
      // ждать DEBOUNCE_MS, пока сработает эффект синхронизации выше,
      // а результат ИИ-поиска должен применяться сразу.
      const priceMinStr = r.priceMin != null ? String(r.priceMin) : '';
      const priceMaxStr = r.priceMax != null ? String(r.priceMax) : '';
      setPriceMinInput(priceMinStr);
      setPriceMaxInput(priceMaxStr);
      setPriceMin(priceMinStr);
      setPriceMax(priceMaxStr);

      const areaMinStr = r.areaMin != null ? String(r.areaMin) : '';
      const areaMaxStr = r.areaMax != null ? String(r.areaMax) : '';
      setAreaMinInput(areaMinStr);
      setAreaMaxInput(areaMaxStr);
      setAreaMin(areaMinStr);
      setAreaMax(areaMaxStr);

      const qStr = r.q || '';
      setSearchInput(qStr);
      setSearch(qStr);
    } catch (err) {
      setAiError('Не получилось связаться с сервером — попробуйте ещё раз');
    } finally {
      setAiSearching(false);
    }
  }, [aiQuery, authFetch]);

  const buildListingsUrl = useCallback((pageToLoad) => {
    const params = new URLSearchParams({
      days: daysRange,
      page: String(pageToLoad),
      pageSize: String(PAGE_SIZE),
    });
    if (search) params.set('q', search);
    if (dealFilter !== 'all') params.set('deal', dealFilter);
    if (typeFilter !== 'all') params.set('type', typeFilter);
    if (roomsFilter.length) params.set('rooms', roomsFilter.join(','));
    if (badgeFilter !== 'all') params.set('badge', badgeFilter);
    if (contactedFilter !== 'all') {
      params.set('contacted', contactedFilter === 'contacted' ? 'yes' : 'no');
    }
    if (districtFilter.length) params.set('district', districtFilter.join(','));
    if (sortBy !== 'new') params.set('sort', sortBy);
    if (priceCurrency !== 'all') params.set('currency', priceCurrency);
    if (priceMin) params.set('priceMin', priceMin);
    if (priceMax) params.set('priceMax', priceMax);
    if (typeFilter === 'commercial' && areaMin) params.set('areaMin', areaMin);
    if (typeFilter === 'commercial' && areaMax) params.set('areaMax', areaMax);
    if (assignedFilter === 'none') params.set('assigned', 'none');
    return `/api/listings?${params.toString()}`;
  }, [daysRange, search, dealFilter, typeFilter, roomsFilter, badgeFilter, contactedFilter, districtFilter, sortBy, priceCurrency, priceMin, priceMax, areaMin, areaMax, assignedFilter]);

  const fetchStats = useCallback(async () => {
    const res = await authFetch(`/api/stats?days=${daysRange}`);
    if (!res) return;
    try {
      setStats(await res.json());
    } catch {
      // тихо игнорируем — статистика не критична для работы ленты
    }
  }, [authFetch, daysRange]);

  const requestIdRef = useRef(0);
  useEffect(() => {
    if (!session) return;
    const myRequestId = ++requestIdRef.current;
    setLoadingInitial(true);
    setPage(0);
    setSelectedIds(new Set());
    authFetch(buildListingsUrl(0)).then(async (res) => {
      if (!res || myRequestId !== requestIdRef.current) return;
      try {
        const data = await res.json();
        setItems(data.items);
        setHasMore(data.hasMore);
        setStatusText('Обновлено ' + new Date().toLocaleTimeString('ru-RU'));
      } catch {
        setStatusText('Не удалось связаться с сервером');
      } finally {
        setLoadingInitial(false);
      }
    });
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, buildListingsUrl]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    const res = await authFetch(buildListingsUrl(nextPage));
    if (res) {
      try {
        const data = await res.json();
        setItems((prev) => {
          const seen = new Set(prev.map((l) => l.id));
          return [...prev, ...data.items.filter((l) => !seen.has(l.id))];
        });
        setHasMore(data.hasMore);
        setPage(nextPage);
      } catch {
        // не критично — просто не увеличиваем page, кнопка останется доступной
      }
    }
    setLoadingMore(false);
  }, [loadingMore, hasMore, page, authFetch, buildListingsUrl]);

  // Автообновление — только сортировка "новые сверху" имеет смысл
  // тихо пополнять; при сортировке по цене новый элемент может лечь
  // в середину списка, поэтому автообновление в этом режиме не трогаем.
  useEffect(() => {
    if (!session || sortBy !== 'new') return;

    const tick = async () => {
      const res = await authFetch(buildListingsUrl(0));
      if (!res) return;
      try {
        const data = await res.json();
        setItems((prev) => {
          const seen = new Set(prev.map((l) => l.id));
          const fresh = data.items.filter((l) => !seen.has(l.id));
          if (fresh.length === 0) return prev;
          return [...fresh, ...prev];
        });
        setStatusText('Обновлено ' + new Date().toLocaleTimeString('ru-RU'));
      } catch {
        // тихо пропускаем один цикл автообновления
      }
      fetchStats();
    };

    let id = setInterval(tick, REFRESH_MS);

    // Пока вкладка в фоне — не долбим сервер (и не тратим впустую
    // протухший токен), а при возврате фокуса сразу перезапрашиваем:
    // к этому моменту authFetch уже успеет обновить сессию сам.
    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(id);
      } else {
        tick();
        id = setInterval(tick, REFRESH_MS);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session, sortBy, authFetch, buildListingsUrl, fetchStats]);

  const toggleContacted = useCallback(async (id, next) => {
    setItems((prev) => prev.map((l) => (l.id === id ? { ...l, contacted: next } : l)));
    await authFetch(`/api/contacted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, contacted: next }),
    });
  }, [authFetch]);

  const saveNote = useCallback(async (id, notes) => {
    setItems((prev) => prev.map((l) => (l.id === id ? { ...l, notes } : l)));
    await authFetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, notes }),
    });
  }, [authFetch]);

  const myEmail = session?.user?.email;

  const toggleAssign = useCallback(async (id) => {
    const res = await authFetch('/api/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res) return;
    if (res.ok) {
      const data = await res.json();
      setItems((prev) => prev.map((l) => (l.id === id ? { ...l, assigned_to: data.assigned_to, assigned_at: data.assigned_at } : l)));
    } else if (res.status === 409) {
      const body = await res.json().catch(() => null);
      if (body?.assigned_to) {
        setItems((prev) => prev.map((l) => (l.id === id ? { ...l, assigned_to: body.assigned_to } : l)));
      }
    }
  }, [authFetch]);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAllLoaded = useCallback(() => setSelectedIds(new Set(items.map((l) => l.id))), [items]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const bulkMarkContacted = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkWorking(true);
    setItems((prev) => prev.map((l) => (selectedIds.has(l.id) ? { ...l, contacted: true } : l)));
    await Promise.all(ids.map((id) =>
      authFetch('/api/contacted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, contacted: true }),
      })
    ));
    setSelectedIds(new Set());
    setBulkWorking(false);
  }, [selectedIds, authFetch]);

  const [cleaningAgents, setCleaningAgents] = useState(false);

  const cleanAgents = useCallback(async () => {
    setCleaningAgents(true);
    let totalDeleted = 0;
    let totalFailed = 0;
    let more = true;
    try {
      while (more) {
        const res = await authFetch('/api/clean-agents', { method: 'POST' });
        if (!res?.ok) break;
        const data = await res.json();
        totalDeleted += data.deleted;
        totalFailed += data.failed;
        more = data.hasMore;
        setStatusText(`Чищу агентские посты... удалено ${totalDeleted}`);
      }
      setStatusText(`Готово: удалено ${totalDeleted}${totalFailed ? `, не удалось ${totalFailed}` : ''}`);
    } finally {
      setCleaningAgents(false);
    }
  }, [authFetch]);

  const clearAll = useCallback(async () => {
    const confirmed = window.confirm(
      'Удалить все объявления из базы? Это нельзя отменить. При следующей проверке сегодняшние объявления придут заново.'
    );
    if (!confirmed) return;
    const res = await authFetch('/api/clear', { method: 'POST' });
    if (res?.ok) {
      setItems([]);
      setHasMore(false);
      setSelectedIds(new Set());
      fetchStats();
    }
  }, [authFetch, fetchStats]);

  const resetFilters = useCallback(() => {
    setSearchInput('');
    setSearch('');
    setDealFilter('all');
    setTypeFilter('all');
    setRoomsFilter([]);
    setBadgeFilter('all');
    setContactedFilter('all');
    setDistrictFilter([]);
    setSortBy('new');
    setPriceCurrency('all');
    setPriceMinInput('');
    setPriceMaxInput('');
    setPriceMin('');
    setPriceMax('');
    setAreaMinInput('');
    setAreaMaxInput('');
    setAreaMin('');
    setAreaMax('');
    setAssignedFilter('all');
  }, []);

  const filtersActive =
    search || dealFilter !== 'all' || typeFilter !== 'all' || roomsFilter.length > 0 || badgeFilter !== 'all' ||
    contactedFilter !== 'all' || districtFilter.length > 0 || sortBy !== 'new' ||
    priceCurrency !== 'all' || priceMin || priceMax || areaMin || areaMax || assignedFilter !== 'all';

  // ---- Экраны в зависимости от состояния авторизации ----

  if (session === undefined) {
    return <div className="auth-screen"><p className="auth-hint">Загрузка…</p></div>;
  }
  if (!session) {
    return <LoginScreen />;
  }
  if (authorized === false) {
    return <NotAuthorizedScreen email={session.user.email} onSignOut={() => supabase.auth.signOut()} />;
  }

  return (
    <>
      <header>
        <div className="brand-bar">
          <img className="brand-logo" src="/tashkent-apartments-logo.png" alt="Tashkent Apartments" />
        </div>
        <div className="header-top">
          <div>
            <div className="eyebrow">Ташкент · недвижимость</div>
            <h1>Лента новых объявлений</h1>
            <p className="subtitle">Аренда и продажа · OLX.uz + Uybor.uz</p>
          </div>
          <div className="header-actions">
            <button className="btn" onClick={() => setShowTeam(true)}>Команда</button>
            <button className="btn" onClick={() => supabase.auth.signOut()}>Выйти</button>
          </div>
        </div>
        <div className="status-bar">
          <span className="dot" />
          <span>{statusText} · {session.user.email}</span>
        </div>
      </header>

      {showTeam && (
        <TeamPanel authFetch={authFetch} myEmail={session.user.email} onClose={() => setShowTeam(false)} />
      )}

      <main>
        <div className="stats">
          <div className="stat"><div className="num">{stats.total}</div><div className="label">Всего в базе</div></div>
          <div className="stat"><div className="num">{stats.today}</div><div className="label">Сегодня</div></div>
          <div className="stat stat-owner"><div className="num">{stats.owners}</div><div className="label">Собственники</div></div>
          <div className="stat"><div className="num">{stats.notContacted}</div><div className="label">Ещё не связались</div></div>
        </div>

        <div className="toolbar ai-search-bar">
          <input
            type="text"
            placeholder="Спросить своими словами: «3-комнатная в Юнусабаде до 80000$, только от собственника»"
            value={aiQuery}
            onChange={(e) => setAiQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runAiSearch(); }}
            disabled={aiSearching}
          />
          <button type="button" className="btn" onClick={runAiSearch} disabled={aiSearching || !aiQuery.trim()}>
            {aiSearching ? 'Ищу…' : '🔎 ИИ-поиск'}
          </button>
          {aiError && <span className="ai-search-error">{aiError}</span>}
        </div>

        <div className="toolbar">
          <input
            type="text"
            placeholder="Поиск по тексту, району…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <DistrictFilter selected={districtFilter} onChange={setDistrictFilter} />
          <select value={dealFilter} onChange={(e) => setDealFilter(e.target.value)}>
            <option value="all">Аренда и продажа</option>
            <option value="rent">Только аренда</option>
            <option value="sale">Только продажа</option>
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">Все типы</option>
            <option value="apartment">Квартиры</option>
            <option value="house">Дома</option>
            <option value="commercial">Коммерция</option>
          </select>
          {typeFilter !== 'commercial' && <RoomsFilter selected={roomsFilter} onChange={setRoomsFilter} />}
          <select value={badgeFilter} onChange={(e) => setBadgeFilter(e.target.value)}>
            <option value="all">Все объявления</option>
            <option value="owner">Только собственники</option>
            <option value="unsure">Сомнительные</option>
          </select>
          <select value={daysRange} onChange={(e) => setDaysRange(e.target.value)}>
            <option value="3">За 3 дня</option>
            <option value="7">За неделю</option>
            <option value="all">Вся история</option>
          </select>
          <select value={contactedFilter} onChange={(e) => setContactedFilter(e.target.value)}>
            <option value="all">Все (связались/нет)</option>
            <option value="not-contacted">Ещё не связались</option>
            <option value="contacted">Уже связались</option>
          </select>
          <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)}>
            <option value="all">Взято и не взято</option>
            <option value="none">Не взято никем</option>
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="new">Сначала новые</option>
            <option value="price_asc">Цена: дешёвые → дорогие</option>
            <option value="price_desc">Цена: дорогие → дешёвые</option>
          </select>
          <select value={priceCurrency} onChange={(e) => setPriceCurrency(e.target.value)}>
            <option value="all">Любая валюта</option>
            <option value="USD">USD</option>
            <option value="UZS">UZS</option>
          </select>
          <input
            type="number"
            inputMode="numeric"
            placeholder="Цена от"
            className="price-input"
            value={priceMinInput}
            onChange={(e) => setPriceMinInput(e.target.value)}
          />
          <input
            type="number"
            inputMode="numeric"
            placeholder="Цена до"
            className="price-input"
            value={priceMaxInput}
            onChange={(e) => setPriceMaxInput(e.target.value)}
          />
          {typeFilter === 'commercial' && (
            <>
              <input
                type="number"
                inputMode="numeric"
                placeholder="Площадь от, м²"
                className="price-input"
                value={areaMinInput}
                onChange={(e) => setAreaMinInput(e.target.value)}
              />
              <input
                type="number"
                inputMode="numeric"
                placeholder="Площадь до, м²"
                className="price-input"
                value={areaMaxInput}
                onChange={(e) => setAreaMaxInput(e.target.value)}
              />
            </>
          )}
          {filtersActive && (
            <button className="btn" onClick={resetFilters}>Сбросить фильтры</button>
          )}
          <button className="btn" onClick={cleanAgents} disabled={cleaningAgents}>
            {cleaningAgents ? 'Чищу...' : 'Почистить агентские посты'}
          </button>
          <button className="btn btn-danger" onClick={clearAll}>Очистить базу</button>
        </div>

        <p className="results-count">
          Показано: {items.length}{hasMore ? '+' : ''} из {stats.total}
          {items.length > 0 && (
            <>
              {' · '}
              <button type="button" className="link-btn" onClick={selectAllLoaded}>выбрать все загруженные</button>
            </>
          )}
        </p>

        {selectedIds.size > 0 && (
          <div className="bulk-bar">
            <span>Выбрано: {selectedIds.size}</span>
            <button className="btn btn-primary" onClick={bulkMarkContacted} disabled={bulkWorking}>
              {bulkWorking ? 'Отмечаю…' : '✓ Отметить связь у выбранных'}
            </button>
            <button className="btn" onClick={clearSelection}>Снять выделение</button>
          </div>
        )}

        <div className="feed">
          {loadingInitial ? (
            Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)
          ) : items.length === 0 ? (
            <div className="empty">
              <div className="big">Пока пусто</div>
              {filtersActive
                ? 'Ничего не подходит под текущие фильтры'
                : 'Объявления появятся здесь, как только сервер найдёт новые'}
            </div>
          ) : (
            items.map((l) => (
              <Card
                key={l.id}
                listing={l}
                selected={selectedIds.has(l.id)}
                myEmail={myEmail}
                onToggleContacted={toggleContacted}
                onToggleSelect={toggleSelect}
                onSaveNote={saveNote}
                onAssign={toggleAssign}
              />
            ))
          )}
        </div>

        {!loadingInitial && hasMore && (
          <button className="btn btn-loadmore" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Загружаю…' : 'Показать ещё'}
          </button>
        )}
      </main>
    </>
  );
}

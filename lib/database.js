const Database = require("better-sqlite3");
const path = require("path");
const { v4: genuuid } = require("uuid");

const dbpath = path.join(__dirname, "..", "gamedata.db");
const db = new Database(dbpath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    playfabid TEXT PRIMARY KEY,
    oculusid TEXT,
    platform TEXT DEFAULT 'Quest',
    displayname TEXT,
    sessionticket TEXT,
    entitytoken TEXT,
    entityid TEXT,
    entitytype TEXT,
    createdat TEXT DEFAULT (datetime('now')),
    lastlogin TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS friendlinks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playerid TEXT NOT NULL,
    friendid TEXT NOT NULL,
    createdat TEXT DEFAULT (datetime('now')),
    UNIQUE(playerid, friendid)
  );

  CREATE TABLE IF NOT EXISTS privacystates (
    playfabid TEXT PRIMARY KEY,
    state TEXT DEFAULT 'VISIBLE'
  );



  CREATE TABLE IF NOT EXISTS queststatus (
    playfabid TEXT PRIMARY KEY,
    dailypoints TEXT DEFAULT '{}',
    weeklypoints TEXT DEFAULT '{}',
    userpointstotal INTEGER DEFAULT 0,
    updatedat TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matchids (
    matchid TEXT PRIMARY KEY,
    createdby TEXT NOT NULL,
    platform TEXT,
    createdat TEXT DEFAULT (datetime('now')),
    lastping TEXT DEFAULT (datetime('now')),
    isactive INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS matchparticipants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matchid TEXT NOT NULL,
    playfabid TEXT NOT NULL,
    UNIQUE(matchid, playfabid)
  );

  CREATE TABLE IF NOT EXISTS rankeddata (
    playfabid TEXT NOT NULL,
    platform TEXT NOT NULL,
    elo REAL DEFAULT 1000.0,
    majortier INTEGER DEFAULT 0,
    minortier INTEGER DEFAULT 0,
    rankprogress REAL DEFAULT 0.0,
    PRIMARY KEY(playfabid, platform)
  );

  CREATE TABLE IF NOT EXISTS progression (
    mothershipid TEXT NOT NULL,
    trackid TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    PRIMARY KEY(mothershipid, trackid)
  );

  CREATE TABLE IF NOT EXISTS shiftcredits (
    mothershipid TEXT PRIMARY KEY,
    currentcredits INTEGER DEFAULT 100,
    capincreases INTEGER DEFAULT 0,
    capincreasesmax INTEGER DEFAULT 25
  );

  CREATE TABLE IF NOT EXISTS juicerstatus (
    mothershipid TEXT PRIMARY KEY,
    corecount INTEGER DEFAULT 0,
    processingtimesec INTEGER DEFAULT 0,
    processingpercent REAL DEFAULT 0.0,
    overdrivesupply INTEGER DEFAULT 0,
    overdrivecap INTEGER DEFAULT 600,
    coresbyoverdrive INTEGER DEFAULT 0,
    refreshjuice INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS dockwrist (
    mothershipid TEXT PRIMARY KEY,
    upgrade1level INTEGER DEFAULT 0,
    upgrade2level INTEGER DEFAULT 0,
    upgrade3level INTEGER DEFAULT 0,
    upgrade1max INTEGER DEFAULT 5,
    upgrade2max INTEGER DEFAULT 5,
    upgrade3max INTEGER DEFAULT 5
  );

  CREATE TABLE IF NOT EXISTS reactorstats (
    mothershipid TEXT PRIMARY KEY,
    maxdepthreached INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS reactorinventory (
    mothershipid TEXT PRIMARY KEY,
    inventoryjson TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS codeconsumptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mothershipid TEXT NOT NULL,
    playfabid TEXT,
    itemguid TEXT NOT NULL,
    consumedat TEXT DEFAULT (datetime('now')),
    UNIQUE(mothershipid, itemguid)
  );

  CREATE TABLE IF NOT EXISTS redeemable_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'item',
    item_id TEXT NOT NULL DEFAULT '',
    playfab_item_name TEXT NOT NULL DEFAULT '',
    discord_id TEXT DEFAULT '',
    start_time TEXT,
    end_time TEXT,
    max_uses INTEGER DEFAULT -1,
    use_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    created_by TEXT DEFAULT '',
    discord_interaction_token TEXT DEFAULT '',
    discord_channel_id TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS code_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    mothershipid TEXT NOT NULL,
    playfabid TEXT,
    redeemed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (code_id) REFERENCES redeemable_codes(id)
  );

  CREATE INDEX IF NOT EXISTS idx_code_redemptions_mid ON code_redemptions(mothershipid);
  CREATE INDEX IF NOT EXISTS idx_code_redemptions_code ON code_redemptions(code);

  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    playfabid TEXT NOT NULL DEFAULT '',
    mothershipid TEXT NOT NULL DEFAULT '',
    linked_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_discord_links_pfid ON discord_links(playfabid);
  CREATE INDEX IF NOT EXISTS idx_discord_links_mid ON discord_links(mothershipid);

  CREATE TABLE IF NOT EXISTS siquests (
    mothershipid TEXT PRIMARY KEY,
    todayclaimablequests INTEGER DEFAULT 3,
    todayclaimablebonus INTEGER DEFAULT 1,
    todayclaimableidol INTEGER DEFAULT 1,
    inventoryjson TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS competitiveunlocks (
    mothershipid TEXT PRIMARY KEY,
    unlocked INTEGER DEFAULT 0,
    platform TEXT
  );

  CREATE TABLE IF NOT EXISTS sharedmaps (
    mapid TEXT PRIMARY KEY,
    mothershipid TEXT NOT NULL,
    userdatametadatakey TEXT,
    nickname TEXT,
    mapdata TEXT,
    createdat TEXT DEFAULT (datetime('now')),
    updatedat TEXT DEFAULT (datetime('now')),
    votecount INTEGER DEFAULT 0,
    isactive INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS mapvotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapid TEXT NOT NULL,
    mothershipid TEXT NOT NULL,
    vote INTEGER NOT NULL,
    UNIQUE(mapid, mothershipid)
  );

  CREATE TABLE IF NOT EXISTS mothershipplayers (
    userid TEXT PRIMARY KEY,
    mothershipid TEXT NOT NULL UNIQUE,
    token TEXT,
    expirationtime INTEGER DEFAULT 0,
    platform TEXT DEFAULT 'RIFT',
    createdat TEXT DEFAULT (datetime('now')),
    lastlogin TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mothershiptitledata (
    datakey TEXT PRIMARY KEY,
    datavalue TEXT NOT NULL,
    updatedat TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mothershipuserdata (
    mothershipid TEXT NOT NULL,
    keyname TEXT NOT NULL,
    datavalue TEXT DEFAULT '{}',
    updatedat TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(mothershipid, keyname)
  );

  CREATE TABLE IF NOT EXISTS mothershipinventory (
    mothershipid TEXT PRIMARY KEY,
    inventoryjson TEXT DEFAULT '[]',
    updatedat TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS drillupgrades (
    mothershipid TEXT PRIMARY KEY,
    upgradelevel INTEGER DEFAULT 0,
    basepurchased INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS shifts (
    shiftid TEXT PRIMARY KEY,
    mothershipid TEXT NOT NULL,
    coresrequired INTEGER DEFAULT 0,
    numberofplayers INTEGER DEFAULT 0,
    depth INTEGER DEFAULT 0,
    startedat TEXT DEFAULT (datetime('now')),
    completed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS progressionnodes (
    mothershipid TEXT NOT NULL,
    treeid TEXT NOT NULL,
    nodeid TEXT NOT NULL,
    unlockedat TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(mothershipid, treeid, nodeid)
  );

  CREATE TABLE IF NOT EXISTS acceptedagreements (
    playfabid TEXT NOT NULL,
    agreementkey TEXT NOT NULL,
    version TEXT NOT NULL,
    acceptedat TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(playfabid, agreementkey)
  );

  CREATE TABLE IF NOT EXISTS friendpresence (
    playfabid TEXT PRIMARY KEY,
    roomid TEXT DEFAULT '',
    zone TEXT DEFAULT '',
    region TEXT DEFAULT '',
    nickname TEXT DEFAULT '',
    updatedat TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ghostgames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mothershipid TEXT NOT NULL,
    ghost_game_id TEXT,
    event_timestamp TEXT,
    final_cores_balance INTEGER DEFAULT 0,
    total_cores_collected_by_player INTEGER DEFAULT 0,
    total_cores_collected_by_group INTEGER DEFAULT 0,
    total_cores_spent_by_player INTEGER DEFAULT 0,
    total_cores_spent_by_group INTEGER DEFAULT 0,
    gates_unlocked INTEGER DEFAULT 0,
    died INTEGER DEFAULT 0,
    items_purchased TEXT DEFAULT '[]',
    shift_cut_data TEXT DEFAULT '0',
    play_duration INTEGER DEFAULT 0,
    started_late TEXT DEFAULT 'False',
    time_started TEXT DEFAULT '0',
    reason TEXT,
    max_number_in_game INTEGER DEFAULT 0,
    end_number_in_game INTEGER DEFAULT 1,
    items_picked_up TEXT DEFAULT '{}',
    revives INTEGER DEFAULT 0,
    num_shifts_played INTEGER DEFAULT 0,
    game_version TEXT,
    game_environment TEXT,
    createdat TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ghostgames_mothershipid ON ghostgames(mothershipid);
  CREATE INDEX IF NOT EXISTS idx_ghostgames_createdat ON ghostgames(createdat);
`);

// Migration: add discord token/channel columns to redeemable_codes (if missing)
try { db.prepare("ALTER TABLE redeemable_codes ADD COLUMN discord_interaction_token TEXT DEFAULT ''").run(); } catch (_) {}
try { db.prepare("ALTER TABLE redeemable_codes ADD COLUMN discord_channel_id TEXT DEFAULT ''").run(); } catch (_) {}

// Admin sessions table (persistent across restarts)
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    discordid TEXT NOT NULL,
    username TEXT NOT NULL,
    discriminator TEXT DEFAULT '0',
    avatarurl TEXT,
    roles_json TEXT DEFAULT '[]',
    permissions_json TEXT DEFAULT '{}',
    ip TEXT DEFAULT '',
    createdat TEXT DEFAULT (datetime('now'))
  );
`);

// Migration: add ip column to admin_sessions (safe to run even if already added)
try { db.prepare("ALTER TABLE admin_sessions ADD COLUMN ip TEXT DEFAULT ''").run(); } catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_roles (
    role_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    perm_panel INTEGER DEFAULT 0,
    perm_ban INTEGER DEFAULT 0,
    perm_playfab INTEGER DEFAULT 0,
    createdat TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oculus_profiles (
    userid TEXT PRIMARY KEY,
    username TEXT,
    avatar_url TEXT,
    updatedat TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS player_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_playfabid TEXT,
    reporter_name TEXT,
    reported_playfabid TEXT NOT NULL,
    reported_name TEXT,
    reason TEXT,
    room_code TEXT,
    createdat TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_player_reports_reported ON player_reports(reported_playfabid);

  CREATE TABLE IF NOT EXISTS dear_lemmings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mothershipid TEXT NOT NULL,
    message_text TEXT NOT NULL,
    display_name TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','answered','closed')),
    answer_text TEXT DEFAULT '',
    answered_by TEXT DEFAULT '',
    answered_at TEXT,
    createdat TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dear_lemmings_mid ON dear_lemmings(mothershipid);
  CREATE INDEX IF NOT EXISTS idx_dear_lemmings_createdat ON dear_lemmings(createdat DESC);

  CREATE TABLE IF NOT EXISTS qa_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_name TEXT DEFAULT 'Anonymous',
    question_text TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','answered','closed')),
    discord_id TEXT DEFAULT '',
    createdat TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_qa_questions_status ON qa_questions(status);
  CREATE INDEX IF NOT EXISTS idx_qa_questions_createdat ON qa_questions(createdat DESC);

  CREATE TABLE IF NOT EXISTS qa_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    answer_text TEXT NOT NULL,
    answered_by TEXT DEFAULT 'Admin',
    createdat TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (question_id) REFERENCES qa_questions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_qa_answers_qid ON qa_answers(question_id);

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_playfabid TEXT NOT NULL,
    to_discord_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    createdat TEXT DEFAULT (datetime('now')),
    UNIQUE(from_playfabid, to_discord_id)
  );
`);

// Migration: add status/answer columns to dear_lemmings if missing
try { db.exec("ALTER TABLE dear_lemmings ADD COLUMN status TEXT DEFAULT 'pending' CHECK(status IN ('pending','answered','closed'))"); } catch (_) {}
try { db.exec("ALTER TABLE dear_lemmings ADD COLUMN answer_text TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE dear_lemmings ADD COLUMN answered_by TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE dear_lemmings ADD COLUMN answered_at TEXT"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_dear_lemmings_status ON dear_lemmings(status)"); } catch (_) {}

// Load existing sessions + clean expired ones (24h TTL)
try {
  const expired = db.prepare("DELETE FROM admin_sessions WHERE createdat < datetime('now', '-1 day')").run();
  if (expired.changes > 0) console.log("[db] cleaned " + expired.changes + " expired admin sessions");
} catch (_) {}

// Player count history for bot graphs
db.exec(`
  CREATE TABLE IF NOT EXISTS player_count_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    online INTEGER NOT NULL,
    total INTEGER NOT NULL,
    createdat TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_createdat ON player_count_snapshots(createdat);
`);

// Clean snapshots older than 30 days
try {
  const old = db.prepare("DELETE FROM player_count_snapshots WHERE createdat < datetime('now', '-30 days')").run();
} catch (_) {}

// Discord account links
db.exec(`
  CREATE TABLE IF NOT EXISTS discord_links (
    discord_id TEXT PRIMARY KEY,
    playfabid TEXT NOT NULL DEFAULT '',
    mothershipid TEXT NOT NULL DEFAULT '',
    linked_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_discord_links_pfid ON discord_links(playfabid);
  CREATE INDEX IF NOT EXISTS idx_discord_links_mid ON discord_links(mothershipid);
`);

// Migration: add type + discord_id columns to redeemable_codes (if they don't exist yet)
try { db.prepare("ALTER TABLE redeemable_codes ADD COLUMN type TEXT NOT NULL DEFAULT 'item'").run(); } catch (_) {}
try { db.prepare("ALTER TABLE redeemable_codes ADD COLUMN discord_id TEXT DEFAULT ''").run(); } catch (_) {}

// Migration: add last_daily column to players for daily login tracking
try { db.prepare("ALTER TABLE players ADD COLUMN last_daily TEXT DEFAULT ''").run(); } catch (_) {}

// Migration: add active column to discord_links for resync
try { db.prepare("ALTER TABLE discord_links ADD COLUMN active INTEGER DEFAULT 1").run(); } catch (_) {}

// Community Helper tables
db.exec(`
  CREATE TABLE IF NOT EXISTS player_playtime (
    playfabid TEXT PRIMARY KEY,
    minutes REAL DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now'))
  );
`);
// Migration: rolling playtime from old per-month schema
try {
  const cols = db.prepare("PRAGMA table_info(player_playtime)").all();
  if (cols.some(c => c.name === "month")) {
    db.exec("ALTER TABLE player_playtime RENAME TO player_playtime_old");
    db.exec(`CREATE TABLE IF NOT EXISTS player_playtime (
      playfabid TEXT PRIMARY KEY,
      minutes REAL DEFAULT 0,
      last_updated TEXT DEFAULT (datetime('now'))
    )`);
    db.exec(`INSERT INTO player_playtime (playfabid, minutes, last_updated)
      SELECT playfabid, SUM(minutes), COALESCE(MAX(updated_at), datetime('now')) FROM player_playtime_old GROUP BY playfabid`);
    try { db.prepare("DROP TABLE player_playtime_old").run(); } catch (_) {}
  }
} catch (_) {}

// Migration: rolling discord_message_counts from old per-month schema
try {
  const cols = db.prepare("PRAGMA table_info(discord_message_counts)").all();
  if (cols.some(c => c.name === "month")) {
    db.exec("ALTER TABLE discord_message_counts RENAME TO discord_message_counts_old");
    db.exec(`CREATE TABLE IF NOT EXISTS discord_message_counts (
      discord_id TEXT PRIMARY KEY,
      message_count INTEGER DEFAULT 0,
      last_updated TEXT DEFAULT (datetime('now'))
    )`);
    db.exec(`INSERT INTO discord_message_counts (discord_id, message_count, last_updated)
      SELECT discord_id, SUM(message_count), datetime('now') FROM discord_message_counts_old GROUP BY discord_id`);
    try { db.prepare("DROP TABLE discord_message_counts_old").run(); } catch (_) {}
  }
} catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS community_helpers (
    discord_id TEXT PRIMARY KEY,
    playfabid TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    opted_in_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ch_notified (
    discord_id TEXT PRIMARY KEY,
    notified_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migration: old ch_notified (discord_id PK or composite) -> new single-key schema
try {
  const colCheck = db.prepare("PRAGMA table_info(ch_notified)").all();
  const hasMonth = colCheck.some(c => c.name === "month");
  if (hasMonth) {
    db.exec(`ALTER TABLE ch_notified RENAME TO ch_notified_old`);
    db.exec(`
      CREATE TABLE ch_notified (
        discord_id TEXT PRIMARY KEY,
        notified_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`INSERT OR IGNORE INTO ch_notified (discord_id, notified_at) SELECT discord_id, notified_at FROM ch_notified_old`);
    db.exec(`DROP TABLE ch_notified_old`);
  }
} catch (_) {}

// Community Helper Leave of Absence tables
db.exec(`
  CREATE TABLE IF NOT EXISTS ch_loa (
    discord_id TEXT PRIMARY KEY,
    loa_start TEXT NOT NULL,
    loa_end TEXT NOT NULL,
    grace_end TEXT NOT NULL,
    granted_by TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS ch_loa_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    action TEXT NOT NULL,
    loa_start TEXT NOT NULL DEFAULT '',
    loa_end TEXT NOT NULL DEFAULT '',
    grace_end TEXT NOT NULL DEFAULT '',
    granted_by TEXT DEFAULT '',
    recorded_at TEXT DEFAULT (datetime('now'))
  );
`);
// Migration: add granted_by to ch_loa
try { db.prepare("ALTER TABLE ch_loa ADD COLUMN granted_by TEXT DEFAULT ''").run(); } catch (_) {}
db.exec(`CREATE TABLE IF NOT EXISTS ch_booster_notified (discord_id TEXT PRIMARY KEY, notified_at TEXT DEFAULT (datetime('now')))`);

// Gorillanalytics uploads
db.exec(`
  CREATE TABLE IF NOT EXISTS gorillanalytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playfabid TEXT NOT NULL DEFAULT '',
    upload_id TEXT NOT NULL DEFAULT '',
    interval_sec INTEGER DEFAULT 0,
    start_time TEXT DEFAULT '',
    sessions_json TEXT DEFAULT '',
    users_json TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gorillanalytics_pfid ON gorillanalytics(playfabid);
  CREATE INDEX IF NOT EXISTS idx_gorillanalytics_created ON gorillanalytics(created_at);
`);

// Photon room state persistence - stores room properties for rejoin injection
db.exec(`
  CREATE TABLE IF NOT EXISTS room_states (
    gameid TEXT PRIMARY KEY,
    region TEXT DEFAULT '',
    state_json TEXT NOT NULL DEFAULT '{}',
    createdat TEXT DEFAULT (datetime('now')),
    updatedat TEXT DEFAULT (datetime('now'))
  );
`);

// Polls system
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    channel_id TEXT DEFAULT '',
    message_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id INTEGER NOT NULL,
    discord_id TEXT NOT NULL,
    playfabid TEXT DEFAULT '',
    oculusid TEXT DEFAULT '',
    option_index INTEGER NOT NULL,
    is_prediction INTEGER DEFAULT 0,
    voted_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (poll_id, discord_id, is_prediction),
    FOREIGN KEY (poll_id) REFERENCES polls(id)
  );
`);

// Migration: replace old polls/votes tables (pollid PK) with new schema
try {
  const oldPolls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='polls' AND sql LIKE '%pollid%'").get();
  if (oldPolls) {
    const oldVotes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='votes'").get();
    // Save old vote data into temp table before dropping
    if (oldVotes) {
      db.prepare("CREATE TABLE IF NOT EXISTS _migrate_votes AS SELECT pollid as poll_id, playfabid as discord_id, playfabid, coalesce(oculusid,'') as oculusid, optionindex as option_index, coalesce(isprediction,0) as is_prediction FROM votes").run();
      db.prepare("DROP TABLE votes").run();
    }
    db.prepare("DROP TABLE polls").run();
    // Recreate polls and poll_votes with new schema
    db.exec(`CREATE TABLE polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      channel_id TEXT DEFAULT '',
      message_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    )`);
    db.exec(`CREATE TABLE poll_votes (
      poll_id INTEGER NOT NULL,
      discord_id TEXT NOT NULL,
      playfabid TEXT DEFAULT '',
      oculusid TEXT DEFAULT '',
      option_index INTEGER NOT NULL,
      is_prediction INTEGER DEFAULT 0,
      voted_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (poll_id, discord_id, is_prediction),
      FOREIGN KEY (poll_id) REFERENCES polls(id)
    )`);
    // Copy old vote data
    const hasMigrate = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrate_votes'").get();
    if (hasMigrate) {
      db.prepare("INSERT INTO poll_votes (poll_id, discord_id, playfabid, oculusid, option_index, is_prediction) SELECT poll_id, discord_id, playfabid, oculusid, option_index, is_prediction FROM _migrate_votes").run();
      db.prepare("DROP TABLE _migrate_votes").run();
    }
  }
} catch (_) {}
// Migration: add expires_at to polls (new schema, for fresh installs where column may be missing)
try { db.prepare("ALTER TABLE polls ADD COLUMN expires_at TEXT").run(); } catch (_) {}

function ensureplayer(playfabid) {
  const existing = db.prepare("SELECT playfabid FROM players WHERE playfabid = ?").get(playfabid);
  if (!existing) {
    db.prepare("INSERT INTO players (playfabid) VALUES (?)").run(playfabid);
  }
}

function ensurerankeddata(playfabid, platform) {
  const existing = db.prepare("SELECT playfabid FROM rankeddata WHERE playfabid = ? AND platform = ?").get(playfabid, platform);
  if (!existing) {
    db.prepare("INSERT INTO rankeddata (playfabid, platform) VALUES (?, ?)").run(playfabid, platform);
  }
}

function ensureshiftcredits(mothershipid) {
  const existing = db.prepare("SELECT mothershipid FROM shiftcredits WHERE mothershipid = ?").get(mothershipid);
  if (!existing) {
    db.prepare("INSERT INTO shiftcredits (mothershipid) VALUES (?)").run(mothershipid);
  }
}

function ensurejuicerstatus(mothershipid) {
  const existing = db.prepare("SELECT mothershipid FROM juicerstatus WHERE mothershipid = ?").get(mothershipid);
  if (!existing) {
    db.prepare("INSERT INTO juicerstatus (mothershipid) VALUES (?)").run(mothershipid);
  }
}

function ensuredockwrist(mothershipid) {
  const existing = db.prepare("SELECT mothershipid FROM dockwrist WHERE mothershipid = ?").get(mothershipid);
  if (!existing) {
    db.prepare("INSERT INTO dockwrist (mothershipid) VALUES (?)").run(mothershipid);
  }
}

function ensurereactorstats(mothershipid) {
  const existing = db.prepare("SELECT mothershipid FROM reactorstats WHERE mothershipid = ?").get(mothershipid);
  if (!existing) {
    db.prepare("INSERT INTO reactorstats (mothershipid) VALUES (?)").run(mothershipid);
  }
}

function ensurereactorinventory(mothershipid) {
  const existing = db.prepare("SELECT mothershipid FROM reactorinventory WHERE mothershipid = ?").get(mothershipid);
  if (!existing) {
    db.prepare("INSERT INTO reactorinventory (mothershipid) VALUES (?)").run(mothershipid);
  }
}

function ensuresiquests(mothershipid) {
  const existing = db.prepare("SELECT mothershipid FROM siquests WHERE mothershipid = ?").get(mothershipid);
  if (!existing) {
    db.prepare("INSERT INTO siquests (mothershipid) VALUES (?)").run(mothershipid);
  }
}

const MAPID_CHARS = "CFGHKMNPRTWXZ256789";
function genmapid() {
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += MAPID_CHARS[Math.floor(Math.random() * MAPID_CHARS.length)];
  }
  return id;
}

// Admin audit log
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discordid TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    details TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    createdat TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_admin_audit_createdat ON admin_audit_log(createdat);
`);

module.exports = {
  db,
  genuuid,
  ensureplayer,
  ensurerankeddata,
  ensureshiftcredits,
  ensurejuicerstatus,
  ensuredockwrist,
  ensurereactorstats,
  ensurereactorinventory,
  ensuresiquests,
  genmapid,
};

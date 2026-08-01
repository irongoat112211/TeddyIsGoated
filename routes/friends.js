const express = require("express");
const router = express.Router();
const { db } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");
const playfab = require("../lib/playfab");

router.post("/GetFriendsV2", async (req, res) => {
  try {
    const body = req.body || {};
    const playfabid = sanitizestr(body.PlayFabId, 16);

    if (!playfabid) {
      return res.status(400).json({ Result: null, StatusCode: 400, Error: "Missing PlayFabId" });
    }

    const links = db.prepare(
      "SELECT f.friendid, f.createdat FROM friendlinks f WHERE f.playerid = ?"
    ).all(playfabid);

    const friends = [];
    for (const link of links) {
      const pid = link.friendid;
      const presence = db.prepare("SELECT * FROM friendpresence WHERE playfabid = ?").get(pid);
      const fsPrivacy = db.prepare("SELECT state FROM privacystates WHERE playfabid = ?").get(pid);
      const player = db.prepare("SELECT displayname FROM players WHERE playfabid = ?").get(pid);
      let displayName = player && player.displayname ? player.displayname : pid;

      // try PlayFab for display name
      if (!player || !player.displayname) {
        try {
          const pf = await playfab.getplayerprofile(pid);
          if (pf.status === 200 && pf.data && pf.data.data && pf.data.data.PlayerProfile && pf.data.data.PlayerProfile.DisplayName) {
            displayName = pf.data.data.PlayerProfile.DisplayName;
            db.prepare("UPDATE players SET displayname = ? WHERE playfabid = ?").run(displayName, pid);
          }
        } catch {}
      }

      // Hide presence details if friend is HIDDEN or PUBLIC_ONLY — unless requester is EA1F059A3FC8F29F
      const bypass = playfabid === "EA1F059A3FC8F29F";
      let roomId = "", zone = "", region = "";
      if (presence) {
        if (bypass || (!fsPrivacy || fsPrivacy.state === "VISIBLE" || !fsPrivacy.state)) {
          roomId = presence.roomid || "";
          zone = presence.zone || "";
          region = presence.region || "";
        }
      }

      friends.push({
        Presence: {
          FriendLinkId: pid,
          UserName: displayName,
          RoomId: roomId,
          Zone: zone,
          Region: region,
          IsPublic: true,
        },
        Created: link.createdat || new Date().toISOString(),
      });
    }

    let privacystate = 0;
    const prow = db.prepare("SELECT state FROM privacystates WHERE playfabid = ?").get(playfabid);
    if (prow) {
      if (prow.state === "PUBLIC_ONLY") privacystate = 1;
      else if (prow.state === "HIDDEN") privacystate = 2;
    }

    return res.status(200).json({
      Result: {
        Friends: friends,
        MyPrivacyState: privacystate,
      },
      StatusCode: 200,
      Error: null,
    });
  } catch (err) {
    console.error("[friends/getfriends] error:", err.message);
    return res.status(500).json({ Result: null, StatusCode: 500, Error: "Internal error" });
  }
});

router.post("/SetPrivacyState", (req, res) => {
  try {
    const body = req.body || {};
    const playfabid = sanitizestr(body.PlayFabId, 16);
    const state = sanitizestr(body.PrivacyState, 32);

    if (!playfabid) {
      return res.status(400).json({ StatusCode: 400, Error: "Missing PlayFabId" });
    }

    let resolvedstate = state;
    if (state === "0") resolvedstate = "VISIBLE";
    else if (state === "1") resolvedstate = "PUBLIC_ONLY";
    else if (state === "2") resolvedstate = "HIDDEN";

    db.prepare("INSERT OR REPLACE INTO privacystates (playfabid, state) VALUES (?, ?)").run(playfabid, resolvedstate);

    return res.status(200).json({ StatusCode: 200, Error: null });
  } catch (err) {
    console.error("[friends/setprivacy] error:", err.message);
    return res.status(500).json({ StatusCode: 500, Error: "Internal error" });
  }
});

router.post("/RequestFriend", (req, res) => {
  try {
    const body = req.body || {};
    const playfabid = sanitizestr(body.PlayFabId, 16);
    const friendid = sanitizestr(body.FriendFriendLinkId, 64);

    if (!playfabid || !friendid) {
      return res.status(400).json({ error: "Missing fields" });
    }

    try {
      db.prepare("INSERT INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(playfabid, friendid);
      db.prepare("INSERT OR IGNORE INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(friendid, playfabid);
    } catch (e) {
      if (e.message && e.message.includes("UNIQUE")) {
        return res.status(409).json({ error: "Already friends" });
      }
      throw e;
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[friends/addfriend] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/RemoveFriend", (req, res) => {
  try {
    const body = req.body || {};
    const playfabid = sanitizestr(body.PlayFabId, 16);
    const friendid = sanitizestr(body.FriendFriendLinkId, 64);

    if (!playfabid || !friendid) {
      return res.status(400).json({ error: "Missing fields" });
    }

    db.prepare("DELETE FROM friendlinks WHERE playerid = ? AND friendid = ?").run(playfabid, friendid);
    db.prepare("DELETE FROM friendlinks WHERE playerid = ? AND friendid = ?").run(friendid, playfabid);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[friends/removefriend] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;

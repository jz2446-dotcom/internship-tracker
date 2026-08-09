# 📋 My Applications — Dashboard

> **Setup (one-time):** Settings → Community plugins → Browse → install **Dataview** → enable it. Then these tables come alive.
>
> Each row is a note in `Applications/` (one per program). Open a program's note and edit its **applied / stage / referral** fields (and write under *My notes*) — these tables update automatically and your edits **survive every data refresh**. (This is your personal tracker; it's separate from the website's Applied checkbox.)
>
> **Stages:** `to-apply` → `applied` → `OA` → `interview` → `offer` / `rejected`

---

## ✅ Open right now (by deadline)
```dataview
TABLE WITHOUT ID file.link AS Program, company AS Company, deadline AS Closes, acceptance_rate AS "Est. accept", stage AS Stage
FROM "Internship Tracker/Applications"
WHERE status = "open"
SORT deadline ASC
```

## 🎯 My pipeline (anything I've started)
```dataview
TABLE WITHOUT ID file.link AS Program, company AS Company, status AS Status, deadline AS Closes, stage AS Stage
FROM "Internship Tracker/Applications"
WHERE applied = true OR stage != "to-apply"
SORT deadline ASC
```

## ⏰ Known deadlines (don't miss these)
```dataview
TABLE WITHOUT ID file.link AS Program, deadline AS Closes, status AS Status, stage AS Stage
FROM "Internship Tracker/Applications"
WHERE deadline != "" AND deadline != "until filled" AND deadline != "rolling"
SORT deadline ASC
```

## 🟢 Open for Class of 2029 (sophomore-eligible)
```dataview
TABLE WITHOUT ID file.link AS Program, status AS Status, acceptance_rate AS "Est. accept", stage AS Stage
FROM "Internship Tracker/Applications"
WHERE contains(class_years, "2029") AND status != "closed" AND status != "none"
SORT status ASC
```

## 🎓 Sophomore tab
```dataview
TABLE WITHOUT ID file.link AS Program, status AS Status, acceptance_rate AS "Est. accept", stage AS Stage
FROM "Internship Tracker/Applications"
WHERE group = "Sophomore Internships"
SORT status ASC
```

## 📊 Count by status
```dataview
TABLE WITHOUT ID key AS Status, length(rows) AS Count
FROM "Internship Tracker/Applications"
GROUP BY status
SORT length(rows) DESC
```

## 🔎 Browse by agent
```dataview
TABLE WITHOUT ID key AS Agent, length(rows) AS Programs
FROM "Internship Tracker/Applications"
GROUP BY group
SORT key ASC
```

---
*Notes are generated from `data/*.json` by `cloudflare-worker/gen-notes.js` (re-run by the `/refresh-tracker` skill). Your personal fields and notes are always preserved.*

# Master résumé drop folder

Put your résumé here as **`master-resume.docx`** (exact name).

The `/refresh-tracker` run will, *after* open roles are Opus-verified, generate one tailored résumé per open role into `Resumes/<Company - Program>/` (`.docx` + `.pdf`) and make it downloadable from the tracker website.

## Rules the generator MUST follow (do not relax)
- Edit **only the text inside the bullet points under each activity/experience entry**. Nothing else.
- **No** changes to fonts, font sizes, spacing, margins, indentation, or bullet position.
- **Same number of bullets**, in the **same order** — never add, remove, or reorder.
- Each edited bullet must render as **exactly one line that fills to the right margin** (no wrap to two lines, no short bullets).
- Keywords must be **truthful** re-framings of your real experience — no invented skills or accomplishments.

## To force a regen
Delete that role's folder under `Resumes/`. If a role already has a generated PDF, it is skipped.

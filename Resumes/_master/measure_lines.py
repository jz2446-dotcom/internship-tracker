"""Measure rendered text-lines PER BULLET in a resume PDF using PyMuPDF.

Ground truth from inspecting the rendered PDF:
  - Each bullet is marked by a bullet glyph in font ArialMT (x1-x0 < 20).
  - The bullet's body text is font 'Palatino' (PalatinoLinotype), size 10,
    x0 ~ 54.0. A wrapped continuation line is ALSO Palatino at x0 ~ 54.0.
  - Company/title/location/section-header rows are TimesNewRoman.
  - Quirk: a marker glyph's baseline-y can sort slightly AFTER the first body
    line of its own bullet, so we do NOT rely on strict interleave order.

Method (robust): the marker glyphs give the 18 bullet START y-positions. Each
Palatino body line is assigned to the marker whose y is the greatest one that
is <= body.y + tol (i.e. the bullet it visually belongs to). A bullet occupies
exactly ONE line iff exactly one Palatino body line maps to it. Any bullet with
>1 body line WRAPS and FAILS regardless of page count. Independent check:
total Palatino body lines across the experience section must equal 18.

Usage: python measure_lines.py min_amzn_bu.pdf [map_amzn_bu.json]
"""
import sys, json
import fitz  # PyMuPDF

BULLET_FONT_HINT = "Palatino"
MARKER_FONT_HINT = "Arial"
Y_TOL = 6.0  # a marker may sort a few pts below its first body line


def load_expected(map_path, master_docx="master-resume.docx"):
    import docx
    d = docx.Document(master_docx)
    idx = [i for i, p in enumerate(d.paragraphs) if 'List' in (p.style.name or '')]
    master = [d.paragraphs[i].text.strip() for i in idx]
    mp = json.load(open(map_path, encoding="utf-8")) if map_path else {}
    return [mp.get(str(n), master[n]) for n in range(len(master))]


def collect(doc):
    markers = []   # (page, y)
    bodies = []    # (page, y, x0, x1, text)
    # The bullets live in RELEVANT EXPERIENCE + EXTRACURRICULAR EXPERIENCE.
    # The HONORS AND INTERESTS section that follows also uses the Palatino
    # body font for its "Honors:" paragraph, so we must NOT count Palatino
    # lines that appear at/after the HONORS header (else the last bullet is
    # falsely flagged as wrapping into the honors line).
    honors = {}  # page -> y of "HONORS AND INTERESTS" header
    for pno in range(doc.page_count):
        for block in doc[pno].get_text("dict")["blocks"]:
            if "lines" not in block:
                continue
            for ln in block["lines"]:
                txt = "".join(s["text"] for s in ln.get("spans", []))
                if txt.strip().upper().startswith("HONORS AND INTEREST"):
                    y0 = min(s["bbox"][1] for s in ln["spans"])
                    honors.setdefault(pno, y0)
    for pno in range(doc.page_count):
        cutoff = honors.get(pno, float("inf"))
        for block in doc[pno].get_text("dict")["blocks"]:
            if "lines" not in block:
                continue
            for ln in block["lines"]:
                spans = ln.get("spans", [])
                txt = "".join(s["text"] for s in spans)
                if not txt.strip():
                    continue
                x0 = min(s["bbox"][0] for s in spans)
                x1 = max(s["bbox"][2] for s in spans)
                y0 = min(s["bbox"][1] for s in spans)
                font = spans[0]["font"]
                if y0 >= cutoff:
                    continue  # skip HONORS section and below
                if MARKER_FONT_HINT in font and (x1 - x0) < 20:
                    markers.append((pno, y0))
                elif BULLET_FONT_HINT in font:
                    bodies.append((pno, y0, x0, x1, txt))
    markers.sort()
    bodies.sort()
    return markers, bodies


def measure(pdf_path):
    doc = fitz.open(pdf_path)
    npages = doc.page_count
    markers, bodies = collect(doc)

    # assign each body line to a bullet (marker index)
    buckets = {i: [] for i in range(len(markers))}
    unassigned = []
    for (bp, by, bx0, bx1, btxt) in bodies:
        best = None
        for i, (mp, my) in enumerate(markers):
            if mp == bp and my <= by + Y_TOL:
                best = i  # keep the latest qualifying marker
        if best is None:
            unassigned.append((bp, by, bx1, btxt))
        else:
            buckets[best].append((by, bx1, btxt))

    results = []
    for i in range(len(markers)):
        b = sorted(buckets[i])
        nlines = len(b)
        first_x1 = b[0][1] if b else 0.0
        text = " / ".join(t for _, _, t in b)
        results.append({"lines": nlines, "x1_first": first_x1, "text": text})
    total_body = len(bodies)
    return npages, results, total_body, len(markers), unassigned


if __name__ == "__main__":
    pdf = sys.argv[1]
    npages, results, total_body, nmarkers, unassigned = measure(pdf)
    RIGHT = 594.0
    wraps = 0
    print(f"{pdf}: pages={npages} markers={nmarkers} palatino_body_lines={total_body}")
    for i, r in enumerate(results):
        gap = RIGHT - r["x1_first"]
        flag = ""
        if r["lines"] != 1:
            flag = f"  <<WRAP ({r['lines']} lines)"
            wraps += 1
        print(f"  b{i:2d} lines={r['lines']} first_x1={r['x1_first']:6.1f} gap={gap:5.1f}{flag}")
        if flag:
            try:
                print(f"       {r['text'][-70:]!r}")
            except Exception:
                pass
    if unassigned:
        print(f"  WARNING {len(unassigned)} unassigned body lines")
    # Independent assertions: 18 markers, 18 body lines, no wraps.
    ok = (nmarkers == 18 and total_body == 18 and wraps == 0)
    print(f"RESULT: markers={nmarkers}/18 body_lines={total_body}/18 wraps={wraps} => {'PASS' if ok else 'FAIL'}")

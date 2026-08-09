"""End-to-end resume pipeline for all roles.

For each map_<role>.json:
  1. apply the bullet mapping onto master-resume.docx  -> out_<role>.docx
  2. LibreOffice headless render                       -> out_<role>.pdf
  3. PyMuPDF font-subset + deflate compress            -> min_<role>.pdf
  4. measure lines-per-bullet (measure_lines.measure)  -> PASS/FAIL

Prints a summary. Exits non-zero if ANY resume fails the one-line check.

Usage:
  python render_all.py            # all roles
  python render_all.py amzn_bu    # a subset
"""
import sys, os, glob, json, subprocess
import fitz
import measure_lines as M
import build as B  # reuse build(mapping,out_docx) + render(out_docx)

MASTER = "master-resume.docx"


def minify(src_pdf, dst_pdf):
    doc = fitz.open(src_pdf)
    # subset embedded fonts, then save with garbage collection + deflate.
    try:
        doc.subset_fonts()
    except Exception:
        pass
    if os.path.exists(dst_pdf):
        os.remove(dst_pdf)
    doc.save(dst_pdf, garbage=4, deflate=True, clean=True)
    doc.close()


def run_role(role):
    mp = json.load(open(f"map_{role}.json", encoding="utf-8"))
    out_docx = f"out_{role}.docx"
    B.build(mp, out_docx)
    out_pdf = B.render(out_docx)          # out_<role>.pdf
    min_pdf = f"min_{role}.pdf"
    minify(out_pdf, min_pdf)
    npages, results, total_body, nmarkers, unassigned = M.measure(min_pdf)
    wraps = sum(1 for r in results if r["lines"] != 1)
    ok = (nmarkers == 18 and total_body == 18 and wraps == 0 and not unassigned)
    return ok, npages, nmarkers, total_body, wraps, results


if __name__ == "__main__":
    roles = sys.argv[1:] or [
        os.path.basename(f)[4:-5] for f in sorted(glob.glob("map_*.json"))
    ]
    allok = True
    for role in roles:
        ok, npages, nm, tb, wraps, results = run_role(role)
        status = "PASS" if ok else "FAIL"
        print(f"{role:12} pages={npages} markers={nm}/18 body={tb}/18 wraps={wraps} => {status}")
        if not ok:
            allok = False
            for i, r in enumerate(results):
                if r["lines"] != 1:
                    print(f"    b{i:2d} lines={r['lines']} :: {r['text'][-60:]!r}")
    print("=" * 40)
    print("ALL PASS" if allok else "SOME FAILED")
    sys.exit(0 if allok else 1)

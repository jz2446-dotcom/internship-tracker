import sys, json, subprocess, os
import docx, pdfplumber
from reportlab.pdfbase.pdfmetrics import stringWidth
SOFFICE=r"C:\Program Files\LibreOffice\program\soffice.exe"
MASTER="master-resume.docx"
RIGHT=594.0; HANG=36.1; USABLE=RIGHT-HANG
def bullet_idxs(d): return [i for i,p in enumerate(d.paragraphs) if 'List' in (p.style.name or '')]
def rl_w(t): return stringWidth(t,"Times-Roman",10)
def build(mapping, out_docx):
    d=docx.Document(MASTER); idx=bullet_idxs(d)
    for n,gi in enumerate(idx):
        key=str(n)
        if key in mapping and mapping[key] is not None:
            p=d.paragraphs[gi]
            if not p.runs: continue
            p.runs[0].text=mapping[key]
            for r in p.runs[1:]: r.text=""
    d.save(out_docx)
def render(out_docx):
    out_pdf=out_docx.replace(".docx",".pdf")
    if os.path.exists(out_pdf): os.remove(out_pdf)
    subprocess.run([SOFFICE,"--headless","--convert-to","pdf","--outdir",".",out_docx],
                   capture_output=True)
    return out_pdf
# NOTE: the ORIGINAL verifier here was PROXY-BASED and had a blind spot. It
# inferred "one line per bullet" from (pages==1) AND (each bullet's *first*
# rendered line width <= usable width). A bullet that WRAPS but still fits on
# page 1 has a first line packed near full width (passes the width test) and
# its extra wrapped line was invisible because the matcher only counted bullet
# START lines. Result: 11 resumes shipped with wrapped bullets while the check
# reported PASS. The verifier now MEASURES lines-per-bullet directly via
# measure_lines.measure() (counts rendered Palatino body lines between bullet
# markers) plus an independent assertion that total body lines == 18.
import measure_lines as _ML

def measure(out_pdf):
    """Return (npages, per_bullet_results, total_body_lines, n_markers).
    A bullet occupies exactly one line iff exactly one body line maps to it."""
    npages, results, total_body, nmarkers, unassigned = _ML.measure(out_pdf)
    return npages, results, total_body, nmarkers, unassigned

if __name__=="__main__":
    mapping=json.load(open(sys.argv[1],encoding="utf-8")) if len(sys.argv)>1 else {}
    out=sys.argv[2] if len(sys.argv)>2 else "out.docx"
    build(mapping,out); pdf=render(out)
    npages,results,total_body,nmarkers,unassigned=measure(pdf)
    wraps=0
    print(f"pages={npages} markers={nmarkers}/18 body_lines={total_body}/18")
    for i,r in enumerate(results):
        gap=RIGHT-r["x1_first"]
        flag=""
        if r["lines"]!=1:
            flag=f" <<WRAP ({r['lines']} lines)"; wraps+=1
        print(f" b{i:2d} lines={r['lines']} gap={gap:5.1f}{flag}")
    # Independent checks: exactly 18 bullets, exactly 18 rendered body lines
    # (i.e. no wraps and none missing), and no stray body lines.
    ok=(npages==1 and nmarkers==18 and total_body==18 and wraps==0 and not unassigned)
    print(f"RESULT: pages={npages} markers={nmarkers}/18 body_lines={total_body}/18 wraps={wraps}",
          "=> PASS" if ok else "=> FAIL")
    sys.exit(0 if ok else 1)

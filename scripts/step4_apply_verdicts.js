const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Verdicts keyed by apply_url (primary) with fallback by company (for generic/shared URLs).
// verdict: 'open' | 'program-page' | 'closed'
const byUrl = {
  'https://careers.bankofamerica.com/en-us/students/job-detail/14392/enterprise-credit-summer-analyst-program-2027-multiple-locations': { verdict: 'open', close_date: '2026-10-01' },
  'https://careers.bankofamerica.com/en-us/students/job-detail/14443/strategy-and-management-summer-analyst-program-2027-multiple-locations': { verdict: 'open', close_date: '2026-10-01' },
  'https://careers.bankofamerica.com/en-us/students/job-detail/14437/global-risk-summer-2027-analyst-program-multiple-locations': { verdict: 'open', close_date: '2026-10-01' },
  'https://careers.bankofamerica.com/en-us/students/job-detail/14422/finance-management-summer-analyst-program-2027-multiple-locations': { verdict: 'open', close_date: '2026-09-30' },
  'https://careers.blackrock.com/job/new-york/2027-summer-internship-program-amers/45831/90628276544': { verdict: 'open' },
  'https://job-boards.greenhouse.io/tpgcareers/jobs/7789335003': { verdict: 'open' },
  'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210768204': { verdict: 'program-page' },
  'https://www.wellsfargojobs.com/en/jobs/r-555860/2027-finance-summer-internship-early-careers/': { verdict: 'open', close_date: '2026-09-29' },
  'https://www.wellsfargojobs.com/en/jobs/r-555720/2027-commercial-banking-summer-internship-early-careers/': { verdict: 'open', close_date: '2026-09-30' },
  'https://www.wellsfargojobs.com/en/students-graduates/': { verdict: 'program-page' },
  'https://www.capitalonecareers.com/job/mclean/current-master-s-data-science-internship-summer-2027/31238/98043168880': { verdict: 'open' },
  'https://www.amazon.jobs/en/jobs/10435673/2027-amazon-operations-finance-rotational-program-summer-internship': { verdict: 'open' },
  'https://www.amazon.jobs/en/jobs/10435671/2027-amazon-finance-rotation-program-accounting-intern': { verdict: 'open' },
  'https://www.amazon.jobs/en/jobs/10435672/2027-amazon-finance-rotation-program-business-unit-finance-intern': { verdict: 'open' },
  'https://www.amazon.jobs/en/jobs/10435122/2027-tax-intern-summer-internship': { verdict: 'open' },
  'https://ev.careers/jobs/473700610-internship-finance-programs-fall-2026': { verdict: 'open' },
  'https://www.lek.com/join-lek/apply/internships': { verdict: 'program-page' },
  'https://www.bain.com/careers/work-with-us/internships-programs/associate-consultant-internship/': { verdict: 'open' },
  'https://www.alixpartners.com/careers/7713880003/turnaround--restructuring-summer-analyst/': { verdict: 'open' },
  'https://www.alixpartners.com/careers/7725314003/investigations-disputes--economics-summer-analyst/': { verdict: 'open' },
  'https://www.careers.jnj.com/en/jobs/r-079030/summer-2027-finance-internship/': { verdict: 'open', close_date: '2026-11-20' },
  'https://careerhub.students.duke.edu/jobs/l-e-k-consulting-u-s-summer-associate-2027/': { verdict: 'program-page' },
  'https://career.cornell.edu/jobs/alvarez-marsal-llc-intern-core-tax-summer-2027/': { verdict: 'closed' },
  'https://www.alixpartners.com/careers/students-and-recent-graduates/internships/': { verdict: 'program-page' },
  'https://careers.caterpillar.com/en/jobs/r0000380161/2027-summer-corporate-intern-finance/': { verdict: 'closed' },
  'https://careers.caterpillar.com/en/jobs/r0000380150/2027-summer-corporate-intern-pricing/': { verdict: 'closed' },
  'https://www.linkedin.com/jobs/view/financial-management-program-fmp-us-2027-start-at-ge-aerospace-4428691648': { verdict: 'program-page' },
  'https://boeing.wd1.myworkdayjobs.com/en-US/INTERN/job/Finance-Career-Foundation-Program-2027_JR2026511537': { verdict: 'program-page' },
  'https://www.tesla.com/careers/search/job/internship-accounting-finance-fall-2026-271328': { verdict: 'program-page' },
  'https://www.goldmansachs.com/careers/students/programs-and-internships/asia-pacific/off-cycle-internship-program': { verdict: 'open' },
  'https://www.nablacareers.com/finance-jobs/jp-morgan/europe/investment-banking/2027-corporate-investment-bank-global-investment-banking-analyst-program-off-cycle-internship-milan/': { verdict: 'open', close_date: '2026-07-31' },
  'https://careers.blackrock.com/job/london/2027-off-cycle-internship-program-emea/45831/97104654800': { verdict: 'open', close_date: '2026-09-30 (Paris/Zurich); 2026-11-13 (Frankfurt/Munich)' },
  'https://job-boards.greenhouse.io/tpgcareers/jobs/7790706003': { verdict: 'open' },
  'https://careers.tsmc.com/en_US/careers/JobDetail/Summer-Fall-2026-Circuit-Design-Research-Intern-7339/19314': { verdict: 'program-page' },
  'https://careers.ibm.com/en_US/careers/JobDetail/Associate-Package-Consultant-Co-op-2026-Financial-Services/64446': { verdict: 'program-page' },
  'https://www.governmentjobs.com/careers/sanjoseca/jobs/newprint/4218232': { verdict: 'open' },
  'https://jobs.whitney.org/apply/4ucWdzfDi5/Fall-2026-Advancement-Individual-Giving-Internship': { verdict: 'open', close_date: '2026-08-14' },
  'https://www.nyhistory.org/careers/internships': { verdict: 'program-page' },
  'https://www.metmuseum.org/opportunities/internships/fall-and-spring-semester-internships-for-undergraduate-and-graduate-students': { verdict: 'open', close_date: '2026-09-16' },
  'https://job-boards.greenhouse.io/tpgcareers/jobs/7789334003': { verdict: 'open' },
  'https://www.worldbank.org/ext/en/careers/talent-programs/wbg-pioneers': { verdict: 'open', posted_date: '2026-07-13', close_date: '2026-08-12' },
  'https://nature.wd108.myworkdayjobs.com/ExternalCareers/job/Remote-Washington-DC/Climate---Conservation-Finance-Policy-Intern_JR102341': { verdict: 'program-page' },
  'https://careerengagement.tulane.edu/jobs/jpmorganchase-2027-global-investment-banking-summer-analyst-program-sustainable-solutions-advisory/': { verdict: 'open', close_date: '2027-01-08' },
  'https://careers.southpole.com/': { verdict: 'open' },
  'https://www.starwoodcapital.com/careers/': { verdict: 'program-page' },
  'https://jobs.jobvite.com/starwoodcapitalgroup': { verdict: 'open' },
  'https://pru.wd5.myworkdayjobs.com/en-US/Careers/job/Arlington-VA-USA/PGIM--2027-Real-Estate--Agency-Summer-Investment-Analyst-Program_R-124636-2': { verdict: 'program-page' },
  'https://mlt.org/career-prep/': { verdict: 'open', close_date: '2027-01-15 (final); priority Aug 1 2026 for Finance track' },
  'https://higher.gs.com/roles/169893': { verdict: 'open', close_date: '2026-09-30' },
  'https://www.nablacareers.com/finance-jobs/jp-morgan/asia/asset-wealth-management/2027-global-private-bank-investment-solutions-program-summer-internship-hong-kong/': { verdict: 'open' },
  'https://careers.bankofamerica.com/en-us/students/job-detail/14367/global-investment-banking-summer-analyst-2027-hong-kong-hong-kong-hong-kong': { verdict: 'open', close_date: '2026-09-30' },
  'https://careers.bankofamerica.com/en-us/students/job-detail/14366/global-markets-sales-trading-rotational-summer-analyst-2027-hong-kong-hong-kong-hong-kong': { verdict: 'open', close_date: '2026-09-30' },
  'https://www.hsbc.com/careers/students-and-graduates/internships': { verdict: 'program-page' },
  'https://www.hsbc.com/careers/students-and-graduates/find-a-programme': { verdict: 'program-page' },
  'https://www.goldmansachs.com/careers/students/programs-and-internships/asia-pacific/summer-analyst': { verdict: 'open' },
  'https://higherin.com/jobs/43333/nomura/register-your-interest-global-markets-summer-internship-2027-sales-trading-structuring-research': { verdict: 'open' },
  'https://hk.linkedin.com/jobs/view/trust-intern-mj003011-at-noah-holdings-4385682025': { verdict: 'closed' },
  'https://htisec.wd3.myworkdayjobs.com/en-US/hti_careers/job/Haitong-International-s-Summer-Internship-Program-2026_R25000212': { verdict: 'program-page' },
  'https://jobs.apple.com/en-hk/search?location=china-CHNC&team=internships-STDNT-INTRN': { verdict: 'open' },
  'recruitment@manulife.com': { verdict: 'program-page' },
  // University career-center mirrors of JPM postings — not fetched from JPM's own site, unconfirmable
  'https://career.eoss.asu.edu/jobs/jpmorganchase-2027-markets-summer-analyst-program/': { verdict: 'program-page' },
  'https://cdo.mit.edu/jobs/jpmorgan-chase-co-2027-commercial-investment-bank-risk-management-summer-analyst-program/': { verdict: 'program-page' },
  'https://career.mercy.edu/jobs/jpmorganchase-2027-global-private-bank-advisor-program-summer-analyst-us-private-bank/': { verdict: 'program-page' },
  'https://career.mercy.edu/jobs/jpmorganchase-2027-commercial-investment-bank-securities-services-leadership-program-summer-analyst-program/': { verdict: 'program-page' },
  'https://career.mercy.edu/jobs/jpmorganchase-2027-commercial-investment-bank-innovation-development-summer-analyst-program-product-track/': { verdict: 'program-page' },
  'https://career.mercy.edu/jobs/jpmorganchase-2027-asset-management-client-summer-analyst-program/': { verdict: 'program-page' },
  'https://businesscareerhub.fiu.edu/jobs/jpmorganchase-2027-global-corporate-banking-summer-analyst-program/': { verdict: 'program-page' },
  'https://www.vanguardjobs.com/students/': { verdict: 'program-page' },
  'https://ocs.yale.edu/jobs/hsbc-holdings-plc-2027-hsbc-singapore-cib-summer-internship-programmes/': { verdict: 'open', close_date: '2026-10-30' },
  'https://www.mizuhogroup.com/americas/careers/campus-recruiting': { verdict: 'program-page' },
  'https://www.smbcgroup.com/americas/careers': { verdict: 'program-page' },
  'https://en.cicc.com/join-cicc/index.html': { verdict: 'program-page' },
};

let touched = {};
let counts = { open: 0, 'program-page': 0, closed: 0, unmatched: 0 };

const files = fs.readdirSync(DATA_DIR).filter(f => /_results\.json$/.test(f));
for (const f of files) {
  const fp = path.join(DATA_DIR, f);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  let changed = false;
  for (const e of data.internships) {
    if (e.status !== 'open') continue;
    const v = byUrl[e.apply_url];
    if (!v) { counts.unmatched++; continue; }
    if (v.verdict !== 'open') {
      e.status = v.verdict;
      delete e.posted_date;
      delete e.close_date;
      changed = true;
    } else {
      if (v.close_date) e.close_date = String(v.close_date);
      if (v.posted_date) e.posted_date = String(v.posted_date);
    }
    counts[v.verdict]++;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    touched[f] = true;
  }
}

console.log('Counts:', counts);
console.log('Files touched:', Object.keys(touched));

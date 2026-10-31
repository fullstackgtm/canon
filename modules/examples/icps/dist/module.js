var DEPARTMENT = [
  ["Revenue operations", /\brev(enue)?\s*ops\b|\brevenue operations\b|\bsales operations\b|\bsales ops\b|\bgtm operations\b/],
  ["Customer success", /\bcustomer success\b|\bcustomer experience\b|\bclient success\b/],
  ["Business development", /\bbusiness development\b|\bbdr\b|\bpartnerships?\b|\balliances\b/],
  ["Sales", /\bsales\b|\baccount executive\b|\bsdr\b|\bcro\b|\bchief revenue\b|\brevenue\b|\bcommercial\b/],
  ["Marketing", /\bmarketing\b|\bcmo\b|\bgrowth\b|\bdemand gen|\bbrand\b|\bcontent\b/],
  ["Finance", /\bfinance\b|\bfinancial\b|\bcfo\b|\baccounting\b|\bcontroller\b|\btreasur/],
  ["Engineering", /\bengineer|\bcto\b|\bdeveloper\b|\bsoftware\b|\bdevops\b|\btechnology\b/],
  ["Product", /\bproduct\b|\bcpo\b/],
  ["IT", /\bit\b|\binformation technology\b|\bcio\b|\binformation security\b|\bciso\b|\bsystems\b/],
  ["HR", /\bhr\b|\bhuman resources\b|\bpeople\b|\btalent\b|\brecruit|\bchro\b/],
  ["Legal", /\blegal\b|\bcounsel\b|\bcompliance\b|\bclo\b/],
  ["Operations", /\boperations\b|\bcoo\b|\bops\b/]
];
function classifyTitle(table, title) {
  const t = (title ?? "").toLowerCase();
  return t && table.find(([, re]) => re.test(t))?.[0] || null;
}

var EMPLOYEE_BANDS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
var LEVELS = [
  { value: "cxo", label: "C-suite" },
  { value: "vp", label: "VP" },
  { value: "head", label: "Head" },
  { value: "director", label: "Director" },
  { value: "manager", label: "Manager" },
  { value: "owner", label: "Owner" },
  { value: "founder", label: "Founder" },
  { value: "partner", label: "Partner" },
  { value: "senior", label: "Senior" }
];
var DEPARTMENTS = ["Sales", "Marketing", "Revenue operations", "Operations", "Finance", "Customer success", "Business development", "Engineering", "Product", "IT", "HR", "Legal"];
function canonDepartments(values) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean).map((v) => DEPARTMENTS.find((d) => d.toLowerCase() === v.toLowerCase()) ?? classifyTitle(DEPARTMENT, v) ?? v))];
}
var COUNTRIES = [
  ["us", "United States"],
  ["ca", "Canada"],
  ["gb", "United Kingdom"],
  ["ie", "Ireland"],
  ["de", "Germany"],
  ["fr", "France"],
  ["nl", "Netherlands"],
  ["es", "Spain"],
  ["it", "Italy"],
  ["se", "Sweden"],
  ["ch", "Switzerland"],
  ["au", "Australia"],
  ["nz", "New Zealand"],
  ["sg", "Singapore"],
  ["in", "India"],
  ["jp", "Japan"],
  ["il", "Israel"],
  ["br", "Brazil"],
  ["mx", "Mexico"]
].map(([value, label]) => ({ value, label }));

var SIZE_BANDS = [
  { key: "1-10", label: "1–10", min: 0, max: 10 },
  { key: "11-50", label: "11–50", min: 11, max: 50 },
  { key: "51-200", label: "51–200", min: 51, max: 200 },
  { key: "201-500", label: "201–500", min: 201, max: 500 },
  { key: "501-1000", label: "501–1,000", min: 501, max: 1e3 },
  { key: "1001-5000", label: "1,001–5,000", min: 1001, max: 5e3 },
  { key: "5001-10000", label: "5,001–10,000", min: 5001, max: 1e4 },
  { key: "10001+", label: "10,001+", min: 10001, max: Number.MAX_SAFE_INTEGER }
];
var REGIONS = [
  { key: "north-america", label: "North America" },
  { key: "latin-america", label: "Latin America" },
  { key: "europe", label: "Europe" },
  { key: "middle-east-africa", label: "Middle East & Africa" },
  { key: "asia-pacific", label: "Asia-Pacific" },
  { key: "other", label: "Other" }
];
var REGION_COUNTRIES = {
  "north-america": ["united states", "usa", "us", "united states of america", "canada", "ca"],
  "latin-america": [
    "mexico",
    "mx",
    "brazil",
    "br",
    "argentina",
    "ar",
    "chile",
    "cl",
    "colombia",
    "co",
    "peru",
    "pe",
    "venezuela",
    "ve",
    "ecuador",
    "ec",
    "uruguay",
    "uy",
    "paraguay",
    "py",
    "bolivia",
    "bo",
    "costa rica",
    "cr",
    "panama",
    "pa",
    "guatemala",
    "gt",
    "dominican republic",
    "do",
    "puerto rico",
    "pr",
    "el salvador",
    "sv",
    "honduras",
    "hn",
    "nicaragua",
    "ni",
    "jamaica",
    "jm",
    "trinidad and tobago",
    "tt",
    "cuba",
    "cu",
    "bahamas",
    "bs",
    "barbados",
    "bb"
  ],
  europe: [
    "united kingdom",
    "uk",
    "gb",
    "great britain",
    "england",
    "scotland",
    "wales",
    "northern ireland",
    "ireland",
    "ie",
    "germany",
    "de",
    "france",
    "fr",
    "spain",
    "es",
    "italy",
    "it",
    "netherlands",
    "nl",
    "belgium",
    "be",
    "luxembourg",
    "lu",
    "switzerland",
    "ch",
    "austria",
    "at",
    "sweden",
    "se",
    "norway",
    "no",
    "denmark",
    "dk",
    "finland",
    "fi",
    "iceland",
    "is",
    "portugal",
    "pt",
    "poland",
    "pl",
    "czechia",
    "czech republic",
    "cz",
    "slovakia",
    "sk",
    "hungary",
    "hu",
    "romania",
    "ro",
    "bulgaria",
    "bg",
    "greece",
    "gr",
    "croatia",
    "hr",
    "slovenia",
    "si",
    "serbia",
    "rs",
    "estonia",
    "ee",
    "latvia",
    "lv",
    "lithuania",
    "lt",
    "ukraine",
    "ua",
    "belarus",
    "by",
    "russia",
    "ru",
    "moldova",
    "md",
    "bosnia and herzegovina",
    "ba",
    "north macedonia",
    "mk",
    "albania",
    "al",
    "montenegro",
    "me",
    "malta",
    "mt",
    "cyprus",
    "cy",
    "monaco",
    "mc",
    "liechtenstein",
    "li"
  ],
  "middle-east-africa": [
    "israel",
    "il",
    "united arab emirates",
    "ae",
    "uae",
    "saudi arabia",
    "sa",
    "qatar",
    "qa",
    "kuwait",
    "kw",
    "bahrain",
    "bh",
    "oman",
    "om",
    "jordan",
    "jo",
    "lebanon",
    "lb",
    "turkey",
    "türkiye",
    "tr",
    "iran",
    "ir",
    "iraq",
    "iq",
    "egypt",
    "eg",
    "south africa",
    "za",
    "nigeria",
    "ng",
    "kenya",
    "ke",
    "ghana",
    "gh",
    "morocco",
    "ma",
    "tunisia",
    "tn",
    "algeria",
    "dz",
    "ethiopia",
    "et",
    "uganda",
    "ug",
    "tanzania",
    "tz",
    "rwanda",
    "rw",
    "senegal",
    "sn",
    "ivory coast",
    "côte d'ivoire",
    "ci",
    "cameroon",
    "cm",
    "zimbabwe",
    "zw",
    "zambia",
    "zm",
    "botswana",
    "bw",
    "namibia",
    "na",
    "mauritius",
    "mu",
    "angola",
    "ao"
  ],
  "asia-pacific": [
    "china",
    "cn",
    "japan",
    "jp",
    "south korea",
    "korea",
    "kr",
    "india",
    "in",
    "singapore",
    "sg",
    "australia",
    "au",
    "new zealand",
    "nz",
    "hong kong",
    "hk",
    "taiwan",
    "tw",
    "indonesia",
    "id",
    "malaysia",
    "my",
    "thailand",
    "th",
    "vietnam",
    "vn",
    "philippines",
    "ph",
    "pakistan",
    "pk",
    "bangladesh",
    "bd",
    "sri lanka",
    "lk",
    "nepal",
    "np",
    "cambodia",
    "kh",
    "myanmar",
    "mm",
    "mongolia",
    "mn",
    "kazakhstan",
    "kz",
    "uzbekistan",
    "uz",
    "macau",
    "mo"
  ]
};
var REGION_OF_COUNTRY = Object.fromEntries(
  Object.entries(REGION_COUNTRIES).flatMap(([region, countries]) => countries.map((c) => [c, region]))
);
var COUNTRY_NAME_BY_ISO = { us: "united states", ca: "canada", mx: "mexico", br: "brazil", ar: "argentina", cl: "chile", co: "colombia", pe: "peru", ve: "venezuela", ec: "ecuador", uy: "uruguay", py: "paraguay", bo: "bolivia", cr: "costa rica", pa: "panama", gt: "guatemala", do: "dominican republic", pr: "puerto rico", sv: "el salvador", hn: "honduras", ni: "nicaragua", jm: "jamaica", tt: "trinidad and tobago", cu: "cuba", bs: "bahamas", bb: "barbados", gb: "united kingdom", ie: "ireland", de: "germany", fr: "france", es: "spain", it: "italy", nl: "netherlands", be: "belgium", lu: "luxembourg", ch: "switzerland", at: "austria", se: "sweden", no: "norway", dk: "denmark", fi: "finland", is: "iceland", pt: "portugal", pl: "poland", cz: "czech republic", sk: "slovakia", hu: "hungary", ro: "romania", bg: "bulgaria", gr: "greece", hr: "croatia", si: "slovenia", rs: "serbia", ee: "estonia", lv: "latvia", lt: "lithuania", ua: "ukraine", by: "belarus", ru: "russia", md: "moldova", ba: "bosnia and herzegovina", mk: "north macedonia", al: "albania", me: "montenegro", mt: "malta", cy: "cyprus", mc: "monaco", li: "liechtenstein", il: "israel", ae: "united arab emirates", sa: "saudi arabia", qa: "qatar", kw: "kuwait", bh: "bahrain", om: "oman", jo: "jordan", lb: "lebanon", tr: "turkey", ir: "iran", iq: "iraq", eg: "egypt", za: "south africa", ng: "nigeria", ke: "kenya", gh: "ghana", ma: "morocco", tn: "tunisia", dz: "algeria", et: "ethiopia", ug: "uganda", tz: "tanzania", rw: "rwanda", sn: "senegal", ci: "côte d'ivoire", cm: "cameroon", zw: "zimbabwe", zm: "zambia", bw: "botswana", na: "namibia", mu: "mauritius", ao: "angola", cn: "china", jp: "japan", kr: "south korea", in: "india", sg: "singapore", au: "australia", nz: "new zealand", hk: "hong kong", tw: "taiwan", id: "indonesia", my: "malaysia", th: "thailand", vn: "vietnam", ph: "philippines", pk: "pakistan", bd: "bangladesh", lk: "sri lanka", np: "nepal", kh: "cambodia", mm: "myanmar", mn: "mongolia", kz: "kazakhstan", uz: "uzbekistan", mo: "macau" };

var ISO_TO_COUNTRY = { ...COUNTRY_NAME_BY_ISO, uk: "united kingdom" };
var REGION_TO_COUNTRIES = {
  "north america": ["united states", "canada"],
  europe: ["united kingdom", "germany", "france", "netherlands", "ireland", "spain", "italy", "sweden", "switzerland"],
  emea: ["united kingdom", "germany", "france", "netherlands", "ireland"],
  apac: ["australia", "singapore", "india", "japan", "new zealand"],
  "asia pacific": ["australia", "singapore", "india", "japan", "new zealand"]
};
function icpGeosToCountries(geos) {
  const out = /* @__PURE__ */ new Set();
  for (const geo of geos ?? []) {
    const g = geo.toLowerCase().trim();
    if (ISO_TO_COUNTRY[g]) out.add(ISO_TO_COUNTRY[g]);
    else if (REGION_TO_COUNTRIES[g]) REGION_TO_COUNTRIES[g].forEach((c) => out.add(c));
    else if (Object.values(ISO_TO_COUNTRY).includes(g)) out.add(g);
  }
  return [...out];
}
function icpGeosToIso(geos) {
  const isoFor = /* @__PURE__ */ new Map();
  for (const [iso, name] of Object.entries(ISO_TO_COUNTRY)) if (!isoFor.has(name)) isoFor.set(name, iso === "uk" ? "gb" : iso);
  return [...new Set(icpGeosToCountries(geos).map((name) => isoFor.get(name)).filter((iso) => Boolean(iso)).map((iso) => iso.toUpperCase()))];
}

var CANONICAL = [
  ["accounting", "Accounting"],
  ["administration of justice", "Administration of Justice"],
  ["advertising services", "Advertising Services"],
  ["airlines and aviation", "Airlines and Aviation"],
  ["alternative dispute resolution", "Alternative Dispute Resolution"],
  ["alternative medicine", "Alternative Medicine"],
  ["animation and post-production", "Animation and Post-production"],
  ["appliances, electrical, and electronics manufacturing", "Appliances, Electrical, and Electronics Manufacturing"],
  ["architecture and planning", "Architecture and Planning"],
  ["armed forces", "Armed Forces"],
  ["artists and writers", "Artists and Writers"],
  ["automation machinery manufacturing", "Automation Machinery Manufacturing"],
  ["aviation and aerospace component manufacturing", "Aviation and Aerospace Component Manufacturing"],
  ["banking", "Banking"],
  ["beverage manufacturing", "Beverage Manufacturing"],
  ["biotechnology research", "Biotechnology Research"],
  ["book and periodical publishing", "Book and Periodical Publishing"],
  ["broadcast media production and distribution", "Broadcast Media Production and Distribution"],
  ["business consulting and services", "Business Consulting and Services"],
  ["capital markets", "Capital Markets"],
  ["chemical manufacturing", "Chemical Manufacturing"],
  ["civic and social organizations", "Civic and Social Organizations"],
  ["civil engineering", "Civil Engineering"],
  ["computer and network security", "Computer and Network Security"],
  ["computer games", "Computer Games"],
  ["computer hardware manufacturing", "Computer Hardware Manufacturing"],
  ["computer networking products", "Computer Networking Products"],
  ["computers and electronics manufacturing", "Computers and Electronics Manufacturing"],
  ["construction", "Construction"],
  ["consumer services", "Consumer Services"],
  ["dairy product manufacturing", "Dairy Product Manufacturing"],
  ["defense and space manufacturing", "Defense and Space Manufacturing"],
  ["design services", "Design Services"],
  ["e-learning providers", "E-Learning Providers"],
  ["education administration programs", "Education Administration Programs"],
  ["entertainment providers", "Entertainment Providers"],
  ["environmental services", "Environmental Services"],
  ["events services", "Events Services"],
  ["executive offices", "Executive Offices"],
  ["facilities services", "Facilities Services"],
  ["farming", "Farming"],
  ["financial services", "Financial Services"],
  ["fisheries", "Fisheries"],
  ["food and beverage manufacturing", "Food and Beverage Manufacturing"],
  ["food and beverage services", "Food and Beverage Services"],
  ["freight and package transportation", "Freight and Package Transportation"],
  ["fundraising", "Fundraising"],
  ["furniture and home furnishings manufacturing", "Furniture and Home Furnishings Manufacturing"],
  ["gambling facilities and casinos", "Gambling Facilities and Casinos"],
  ["glass, ceramics and concrete manufacturing", "Glass, Ceramics and Concrete Manufacturing"],
  ["government administration", "Government Administration"],
  ["government relations services", "Government Relations Services"],
  ["graphic design", "Graphic Design"],
  ["higher education", "Higher Education"],
  ["hospitality", "Hospitality"],
  ["hospitals and health care", "Hospitals and Health Care"],
  ["human resources services", "Human Resources Services"],
  ["individual and family services", "Individual and Family Services"],
  ["industrial machinery manufacturing", "Industrial Machinery Manufacturing"],
  ["information services", "Information Services"],
  ["insurance", "Insurance"],
  ["international affairs", "International Affairs"],
  ["international trade and development", "International Trade and Development"],
  ["investment banking", "Investment Banking"],
  ["investment management", "Investment Management"],
  ["it services and it consulting", "IT Services and IT Consulting"],
  ["law enforcement", "Law Enforcement"],
  ["law practice", "Law Practice"],
  ["leasing non-residential real estate", "Leasing Non-residential Real Estate"],
  ["legal services", "Legal Services"],
  ["legislative offices", "Legislative Offices"],
  ["libraries", "Libraries"],
  ["machinery manufacturing", "Machinery Manufacturing"],
  ["manufacturing", "Manufacturing"],
  ["maritime transportation", "Maritime Transportation"],
  ["market research", "Market Research"],
  ["media production", "Media Production"],
  ["medical equipment manufacturing", "Medical Equipment Manufacturing"],
  ["medical practices", "Medical Practices"],
  ["mental health care", "Mental Health Care"],
  ["mining", "Mining"],
  ["mobile gaming apps", "Mobile Gaming Apps"],
  ["motor vehicle manufacturing", "Motor Vehicle Manufacturing"],
  ["movies, videos, and sound", "Movies, Videos, and Sound"],
  ["museums, historical sites, and zoos", "Museums, Historical Sites, and Zoos"],
  ["musicians", "Musicians"],
  ["nanotechnology research", "Nanotechnology Research"],
  ["newspaper publishing", "Newspaper Publishing"],
  ["non-profit organizations", "Non-profit Organizations"],
  ["oil and gas", "Oil and Gas"],
  ["online audio and video media", "Online Audio and Video Media"],
  ["outsourcing and offshoring consulting", "Outsourcing and Offshoring Consulting"],
  ["packaging and containers manufacturing", "Packaging and Containers Manufacturing"],
  ["paper and forest product manufacturing", "Paper and Forest Product Manufacturing"],
  ["performing arts", "Performing Arts"],
  ["personal care product manufacturing", "Personal Care Product Manufacturing"],
  ["pharmaceutical manufacturing", "Pharmaceutical Manufacturing"],
  ["philanthropic fundraising services", "Philanthropic Fundraising Services"],
  ["photography", "Photography"],
  ["plastics manufacturing", "Plastics Manufacturing"],
  ["political organizations", "Political Organizations"],
  ["primary and secondary education", "Primary and Secondary Education"],
  ["printing services", "Printing Services"],
  ["professional training and coaching", "Professional Training and Coaching"],
  ["public policy offices", "Public Policy Offices"],
  ["public relations and communications services", "Public Relations and Communications Services"],
  ["public safety", "Public Safety"],
  ["railroad equipment manufacturing", "Railroad Equipment Manufacturing"],
  ["ranching", "Ranching"],
  ["real estate", "Real Estate"],
  ["recreational facilities", "Recreational Facilities"],
  ["religious institutions", "Religious Institutions"],
  ["renewable energy semiconductor manufacturing", "Renewable Energy Semiconductor Manufacturing"],
  ["research services", "Research Services"],
  ["restaurants", "Restaurants"],
  ["retail", "Retail"],
  ["retail apparel and fashion", "Retail Apparel and Fashion"],
  ["retail art supplies", "Retail Art Supplies"],
  ["retail groceries", "Retail Groceries"],
  ["retail luxury goods and jewelry", "Retail Luxury Goods and Jewelry"],
  ["retail office equipment", "Retail Office Equipment"],
  ["security and investigations", "Security and Investigations"],
  ["semiconductor manufacturing", "Semiconductor Manufacturing"],
  ["shipbuilding", "Shipbuilding"],
  ["software development", "Software Development"],
  ["spectator sports", "Spectator Sports"],
  ["sporting goods manufacturing", "Sporting Goods Manufacturing"],
  ["staffing and recruiting", "Staffing and Recruiting"],
  ["strategic management services", "Strategic Management Services"],
  ["technology, information and internet", "Technology, Information and Internet"],
  ["telecommunications", "Telecommunications"],
  ["textile manufacturing", "Textile Manufacturing"],
  ["think tanks", "Think Tanks"],
  ["tobacco manufacturing", "Tobacco Manufacturing"],
  ["translation and localization", "Translation and Localization"],
  ["transportation, logistics, supply chain and storage", "Transportation, Logistics, Supply Chain and Storage"],
  ["travel arrangements", "Travel Arrangements"],
  ["truck transportation", "Truck Transportation"],
  ["utilities", "Utilities"],
  ["venture capital and private equity principals", "Venture Capital and Private Equity Principals"],
  ["veterinary services", "Veterinary Services"],
  ["warehousing and storage", "Warehousing and Storage"],
  ["wellness and fitness services", "Wellness and Fitness Services"],
  ["wholesale", "Wholesale"],
  ["wholesale building materials", "Wholesale Building Materials"],
  ["wholesale import and export", "Wholesale Import and Export"],
  ["wireless services", "Wireless Services"],
  ["writing and editing", "Writing and Editing"]
];
var EARLIER_NAMES = [
  ["accounting", "accounting"],
  ["airlines/aviation", "airlines and aviation"],
  ["alternative dispute resolution", "alternative dispute resolution"],
  ["alternative medicine", "alternative medicine"],
  ["animation", "animation and post-production"],
  ["apparel & fashion", "retail apparel and fashion"],
  ["architecture & planning", "architecture and planning"],
  ["arts and crafts", "retail art supplies"],
  ["automotive", "motor vehicle manufacturing"],
  ["aviation & aerospace", "aviation and aerospace component manufacturing"],
  ["banking", "banking"],
  ["biotechnology", "biotechnology research"],
  ["broadcast media", "broadcast media production and distribution"],
  ["building materials", "wholesale building materials"],
  ["business supplies and equipment", "retail office equipment"],
  ["capital markets", "capital markets"],
  ["chemicals", "chemical manufacturing"],
  ["civic & social organization", "civic and social organizations"],
  ["civil engineering", "civil engineering"],
  ["commercial real estate", "leasing non-residential real estate"],
  ["computer & network security", "computer and network security"],
  ["computer games", "computer games"],
  ["computer hardware", "computer hardware manufacturing"],
  ["computer networking", "computer networking products"],
  ["computer software", "software development"],
  ["construction", "construction"],
  ["consumer electronics", "computers and electronics manufacturing"],
  ["consumer goods", "manufacturing"],
  ["consumer services", "consumer services"],
  ["cosmetics", "personal care product manufacturing"],
  ["dairy", "dairy product manufacturing"],
  ["defense & space", "defense and space manufacturing"],
  ["design", "design services"],
  ["e-learning", "e-learning providers"],
  ["education management", "education administration programs"],
  ["electrical/electronic manufacturing", "appliances, electrical, and electronics manufacturing"],
  ["entertainment", "entertainment providers"],
  ["environmental services", "environmental services"],
  ["events services", "events services"],
  ["executive office", "executive offices"],
  ["facilities services", "facilities services"],
  ["farming", "farming"],
  ["financial services", "financial services"],
  ["fine art", "artists and writers"],
  ["fishery", "fisheries"],
  ["food & beverages", "food and beverage services"],
  ["food production", "food and beverage manufacturing"],
  ["fund-raising", "fundraising"],
  ["furniture", "furniture and home furnishings manufacturing"],
  ["gambling & casinos", "gambling facilities and casinos"],
  ["glass, ceramics & concrete", "glass, ceramics and concrete manufacturing"],
  ["government administration", "government administration"],
  ["government relations", "government relations services"],
  ["graphic design", "graphic design"],
  ["health, wellness and fitness", "wellness and fitness services"],
  ["higher education", "higher education"],
  ["hospital & health care", "hospitals and health care"],
  ["hospitality", "hospitality"],
  ["human resources", "human resources services"],
  ["import and export", "wholesale import and export"],
  ["individual & family services", "individual and family services"],
  ["industrial automation", "automation machinery manufacturing"],
  ["information services", "information services"],
  ["information technology and services", "it services and it consulting"],
  ["insurance", "insurance"],
  ["international affairs", "international affairs"],
  ["international trade and development", "international trade and development"],
  ["internet", "technology, information and internet"],
  ["investment banking", "investment banking"],
  ["investment management", "investment management"],
  ["judiciary", "administration of justice"],
  ["law enforcement", "law enforcement"],
  ["law practice", "law practice"],
  ["legal services", "legal services"],
  ["legislative office", "legislative offices"],
  ["leisure, travel & tourism", "travel arrangements"],
  ["libraries", "libraries"],
  ["logistics and supply chain", "transportation, logistics, supply chain and storage"],
  ["luxury goods & jewelry", "retail luxury goods and jewelry"],
  ["machinery", "industrial machinery manufacturing"],
  ["management consulting", "business consulting and services"],
  ["maritime", "maritime transportation"],
  ["market research", "market research"],
  ["marketing and advertising", "advertising services"],
  ["mechanical or industrial engineering", "industrial machinery manufacturing"],
  ["media production", "media production"],
  ["medical devices", "medical equipment manufacturing"],
  ["medical practice", "medical practices"],
  ["mental health care", "mental health care"],
  ["military", "armed forces"],
  ["mining & metals", "mining"],
  ["motion pictures and film", "movies, videos, and sound"],
  ["museums and institutions", "museums, historical sites, and zoos"],
  ["music", "musicians"],
  ["nanotechnology", "nanotechnology research"],
  ["newspapers", "newspaper publishing"],
  ["non-profit organization management", "non-profit organizations"],
  ["oil & energy", "oil and gas"],
  ["online media", "online audio and video media"],
  ["outsourcing/offshoring", "outsourcing and offshoring consulting"],
  ["package/freight delivery", "freight and package transportation"],
  ["packaging and containers", "packaging and containers manufacturing"],
  ["paper & forest products", "paper and forest product manufacturing"],
  ["performing arts", "performing arts"],
  ["pharmaceuticals", "pharmaceutical manufacturing"],
  ["philanthropy", "philanthropic fundraising services"],
  ["photography", "photography"],
  ["plastics", "plastics manufacturing"],
  ["political organization", "political organizations"],
  ["primary/secondary education", "primary and secondary education"],
  ["printing", "printing services"],
  ["professional training & coaching", "professional training and coaching"],
  ["program development", "software development"],
  ["public policy", "public policy offices"],
  ["public relations and communications", "public relations and communications services"],
  ["public safety", "public safety"],
  ["publishing", "book and periodical publishing"],
  ["railroad manufacture", "railroad equipment manufacturing"],
  ["ranching", "ranching"],
  ["real estate", "real estate"],
  ["recreational facilities and services", "recreational facilities"],
  ["religious institutions", "religious institutions"],
  ["renewables & environment", "renewable energy semiconductor manufacturing"],
  ["research", "research services"],
  ["restaurants", "restaurants"],
  ["retail", "retail"],
  ["security and investigations", "security and investigations"],
  ["semiconductors", "semiconductor manufacturing"],
  ["shipbuilding", "shipbuilding"],
  ["sporting goods", "sporting goods manufacturing"],
  ["sports", "spectator sports"],
  ["staffing and recruiting", "staffing and recruiting"],
  ["supermarkets", "retail groceries"],
  ["telecommunications", "telecommunications"],
  ["textiles", "textile manufacturing"],
  ["think tanks", "think tanks"],
  ["tobacco", "tobacco manufacturing"],
  ["translation and localization", "translation and localization"],
  ["transportation/trucking/railroad", "truck transportation"],
  ["utilities", "utilities"],
  ["venture capital & private equity", "venture capital and private equity principals"],
  ["veterinary", "veterinary services"],
  ["warehousing", "warehousing and storage"],
  ["wholesale", "wholesale"],
  ["wine and spirits", "beverage manufacturing"],
  ["wireless", "wireless services"],
  ["writing and editing", "writing and editing"]
];
var ALIASES = [
  ["agriculture", "farming"],
  ["apparel", "retail apparel and fashion"],
  ["biotech", "biotechnology research"],
  ["communications", "telecommunications"],
  ["consulting", "business consulting and services"],
  ["electronics", "computers and electronics manufacturing"],
  ["environmental", "environmental services"],
  ["finance", "financial services"],
  ["fintech", "financial services"],
  ["food & beverage", "food and beverage services"],
  ["government", "government administration"],
  ["healthcare", "hospitals and health care"],
  ["health care", "hospitals and health care"],
  ["media", "media production"],
  ["not for profit", "non-profit organizations"],
  ["nonprofit", "non-profit organizations"],
  ["recreation", "recreational facilities"],
  ["shipping", "freight and package transportation"],
  ["technology", "technology, information and internet"],
  ["transportation", "transportation, logistics, supply chain and storage"],
  ["software", "software development"],
  ["saas", "software development"],
  ["it services", "it services and it consulting"],
  ["cybersecurity", "computer and network security"],
  ["staffing", "staffing and recruiting"],
  ["logistics", "transportation, logistics, supply chain and storage"],
  ["pharma", "pharmaceutical manufacturing"]
];
var UNMAPPED_PREFIX = "~";
var INDUSTRIES = CANONICAL.map(([key, label]) => ({ key, label }));
var LABEL = new Map(CANONICAL);
function normIndustry(raw) {
  return ` ${raw.toLowerCase().replace(/[&/,_-]+/g, " ")} `.replace(/ and /g, " ").replace(/\s+/g, " ").trim();
}
var BY_NORM = /* @__PURE__ */ new Map();
for (const [key, label] of CANONICAL) {
  BY_NORM.set(normIndustry(key), key);
  BY_NORM.set(normIndustry(label), key);
}
for (const [name, key] of [...EARLIER_NAMES, ...ALIASES]) if (!BY_NORM.has(normIndustry(name))) BY_NORM.set(normIndustry(name), key);
function canonIndustry(raw) {
  if (!raw || !raw.trim()) return null;
  return BY_NORM.get(normIndustry(raw)) ?? null;
}
function industryLabel(key) {
  if (key.startsWith(UNMAPPED_PREFIX)) return `${key.slice(UNMAPPED_PREFIX.length)} (unmapped)`;
  return LABEL.get(key) ?? key;
}
var sqlLit = (s) => `'${s.replace(/'/g, "''")}'`;
var MAP_SQL = `MAP {${[...BY_NORM].map(([n, k]) => `${sqlLit(n)}: ${sqlLit(k)}`).join(", ")}}`;
var SOURCE_NAMES = /* @__PURE__ */ new Map();
for (const [key, label] of CANONICAL) SOURCE_NAMES.set(key, [key, label.toLowerCase()]);
for (const [name, key] of EARLIER_NAMES) SOURCE_NAMES.get(key).push(name);

var COMPANY = /* @__PURE__ */ new Set(["industry", "size", "country", "region", "city", "owner", "revenue", "field"]);
var SEGMENT_ONLY = /* @__PURE__ */ new Set(["region", "city", "owner", "revenue"]);
var PERSON = /* @__PURE__ */ new Set(["level", "dept", "title", "location"]);
var NEGATABLE = /* @__PURE__ */ new Set(["industry", "country", "region", "owner", "title"]);
var MAX_VALUES = 60;
var MAX_HAS = 4;
var SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
var slugOf = (s) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9+]+/g, "-").replace(/^-|-$/g, "");
var DEPT_BY_SLUG = new Map(DEPARTMENTS.map((d) => [slugOf(d), d]));
var LEVEL_SET = new Set(LEVELS.map((l) => l.value));
var COUNTRY_SET = new Set(COUNTRIES.map((c) => c.value));
var BAND_SET = new Set(EMPLOYEE_BANDS);
var REGION_KEYS = new Set(REGIONS.map((r) => r.key).filter((k) => k !== "other"));
var REVENUE = /^(\d+(?:\.\d+)?)([kmb]?)(?:-(\d+(?:\.\d+)?)([kmb]?)|\+)$/;
function canonValue(key, raw) {
  const v = raw.trim();
  if (!v) return null;
  switch (key) {
    case "industry":
      return canonIndustry(v.replace(/-/g, " "));
    case "size":
      return BAND_SET.has(v) ? v : null;
    case "country":
    case "location":
      return COUNTRY_SET.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "region":
      return REGION_KEYS.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "city":
      return /["()]/.test(v) ? null : v.toLowerCase().slice(0, 80);
    case "owner":
      return v.toLowerCase() === "none" ? "none" : /^[a-z0-9]{8,40}$/.test(v) ? v : null;
    case "revenue":
      return REVENUE.test(v.toLowerCase()) ? v.toLowerCase() : null;
    case "level":
      return LEVEL_SET.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "dept": {
      if (/["()]/.test(v)) return null;
      const department = DEPT_BY_SLUG.get(slugOf(v)) ?? canonDepartments([v.replace(/-/g, " ")])[0];
      return department ? DEPARTMENTS.includes(department) ? department : department.toLowerCase() : null;
    }
    case "title":
      return /["()]/.test(v) ? null : v.slice(0, 120);
  }
}
function writeValue(key, v) {
  if (key === "industry" || key === "dept") return slugOf(v);
  return /^[^\s,"()]+$/.test(v) && !(key === "field" && v.includes("..")) ? v : `"${v}"`;
}
function tokens(text) {
  const out = [];
  let cur = "", depth = 0, quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function splitValues(raw) {
  const out = [];
  let cur = "", quoted = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
var num = (s) => s === void 0 || s.trim() === "" ? void 0 : Number(s);
function parseClause(token, errors) {
  const m = token.match(/^(-?)([a-z_]+)(?:\.([A-Za-z0-9_-]+))?:(.*)$/i);
  if (!m) {
    errors.push(`can't read "${token.slice(0, 40)}": write key:value`);
    return null;
  }
  const [, dash, rawKey, slug, rest] = m;
  const key = rawKey.toLowerCase();
  const neg = dash === "-";
  if (key === "field") {
    if (!slug || !SLUG_RE.test(slug)) {
      errors.push(`field needs an AI field: field.<slug>:answer`);
      return null;
    }
    if (neg) {
      errors.push(`-field.${slug} isn't supported`);
      return null;
    }
    const range = rest.match(/^(-?[\d.]*)\.\.(-?[\d.]*)$/);
    if (range) {
      const min = num(range[1]), max = num(range[2]);
      if (min !== void 0 && !Number.isFinite(min) || max !== void 0 && !Number.isFinite(max) || min === void 0 && max === void 0) {
        errors.push(`field.${slug}: a range is min..max`);
        return null;
      }
      return { key: "field", slug, neg: false, ...min !== void 0 ? { min } : {}, ...max !== void 0 ? { max } : {} };
    }
    const values2 = splitValues(rest).map((v) => v.toLowerCase().slice(0, 120));
    if (!values2.length) {
      errors.push(`field.${slug} needs an answer`);
      return null;
    }
    return { key: "field", slug, neg: false, values: [...new Set(values2)].slice(0, MAX_VALUES) };
  }
  if (slug) {
    errors.push(`unknown key "${rawKey}.${slug}"`);
    return null;
  }
  if (!COMPANY.has(key) && !PERSON.has(key)) {
    errors.push(`unknown key "${rawKey}"`);
    return null;
  }
  if (neg && !NEGATABLE.has(key)) {
    errors.push(`-${key} isn't supported`);
    return null;
  }
  const values = [];
  for (const raw of splitValues(rest)) {
    const v = canonValue(key, raw);
    if (v === null) errors.push(`${key}: no value "${raw}"`);
    else if (!values.includes(v)) values.push(v);
  }
  if (!values.length) {
    if (!errors.length) errors.push(`${key} needs a value`);
    return null;
  }
  return { key, neg, values: values.slice(0, MAX_VALUES) };
}
var clauseId = (c) => `${c.neg ? "-" : ""}${c.key === "field" ? `field.${c.slug}` : c.key}`;
function parseClauses(parts, scope, errors, where) {
  const out = [];
  for (const part of parts) {
    const c = parseClause(part, errors);
    if (!c) continue;
    const isCompany = COMPANY.has(c.key);
    if (scope === "company" && !isCompany) {
      errors.push(`${c.key} describes a person: put it in has(…)${where === "icp" ? "" : " or on a persona"}`);
      continue;
    }
    if (scope === "person" && isCompany) {
      errors.push(`${clauseId(c)} describes the company: put it on the ICP or a segment`);
      continue;
    }
    if (out.some((o) => clauseId(o) === clauseId(c))) {
      errors.push(`${clauseId(c)} appears twice: list its values with commas`);
      continue;
    }
    out.push(c);
  }
  return out;
}
function parseQuery(text, kind) {
  const errors = [];
  const query = { clauses: [], has: [] };
  if ((text.match(/"/g)?.length ?? 0) % 2) errors.push("a quote is never closed");
  const company = [];
  for (const t of tokens(text.trim())) {
    const h = t.match(/^(-?)has\(([\s\S]*)\)$/i);
    if (h) {
      if (kind === "persona") {
        errors.push("has(…) belongs on an ICP or a segment: a persona already is the people");
        continue;
      }
      const clauses = parseClauses(tokens(h[2]), "person", errors, kind);
      if (clauses.length) query.has.push({ neg: h[1] === "-", clauses });
      else errors.push(`${h[1]}has(…) needs who: level, dept or title`);
    } else if (/^-?has\(/i.test(t)) errors.push("a has( is never closed");
    else company.push(t);
  }
  query.clauses = parseClauses(company, kind === "persona" ? "person" : "company", errors, kind);
  const listed = (key) => query.clauses.some((c) => c.key === key && !c.neg);
  if (listed("country") && listed("region")) errors.push("name countries or regions, not both");
  if (kind === "icp") {
    const narrow = query.clauses.find((c) => SEGMENT_ONLY.has(c.key));
    if (narrow) errors.push(`${narrow.key} narrows a segment or a territory, not an ICP: add a segment for it`);
    if (query.has.some((h) => h.neg)) errors.push("-has(…) belongs on a segment: an ICP's has(…) is its buyer");
    if (query.has.filter((h) => !h.neg).length > 1) errors.push("an ICP takes one has(…), its buyer: add a segment to require more");
  }
  if (query.has.length > MAX_HAS) errors.push(`at most ${MAX_HAS} has(…) on a segment`);
  if (kind === "persona" && !query.clauses.length && !errors.length) errors.push("a persona needs who: level, dept or title");
  return { query, errors, source: { text, canonical: formatQuery(query) } };
}
function writeClause(c) {
  if (c.key === "field") {
    if (c.values) return `field.${c.slug}:${c.values.map((v) => writeValue("field", v)).join(",")}`;
    return `field.${c.slug}:${c.min ?? ""}..${c.max ?? ""}`;
  }
  return `${c.neg ? "-" : ""}${c.key}:${c.values.map((v) => writeValue(c.key, v)).join(",")}`;
}
function formatQuery(q) {
  return [...q.clauses.map(writeClause), ...q.has.map((h) => `${h.neg ? "-" : ""}has(${h.clauses.map(writeClause).join(" ")})`)].join(" ");
}
var listOf = (cs, key, neg = false) => cs.find((c) => c.key === key && c.neg === neg)?.values ?? [];
function specToQuery(spec) {
  const list = (key, values, neg = false) => values.length ? [{ key, neg, values: [...values] }] : [];
  const buyer = [
    ...list("level", spec.persona.levels),
    ...list("dept", canonDepartments(spec.persona.departments)),
    ...list("title", spec.persona.titles),
    ...list("location", spec.persona.countries ?? []),
    ...list("title", spec.exclude.titles, true)
  ];
  return formatQuery({
    clauses: [
      ...list("industry", spec.market.industries),
      ...list("size", spec.market.employeeBands),
      ...list("country", spec.market.countries),
      ...list("industry", spec.exclude.industries, true),
      ...list("country", spec.exclude.countries, true),
      ...(spec.custom ?? []).map((c) => ({ key: "field", slug: c.slug, neg: false, ...c.values?.length ? { values: c.values } : {}, ...c.min !== void 0 ? { min: c.min } : {}, ...c.max !== void 0 ? { max: c.max } : {} }))
    ],
    has: buyer.length ? [{ neg: false, clauses: buyer }] : []
  });
}
function queryToSpec(q) {
  const buyer = q.has.find((h) => !h.neg)?.clauses ?? [];
  const custom = q.clauses.flatMap((c) => c.key === "field" ? [{ slug: c.slug, ...c.values ? { values: c.values } : {}, ...c.min !== void 0 ? { min: c.min } : {}, ...c.max !== void 0 ? { max: c.max } : {} }] : []);
  return {
    market: { industries: listOf(q.clauses, "industry"), employeeBands: listOf(q.clauses, "size"), countries: listOf(q.clauses, "country") },
    persona: { levels: listOf(buyer, "level"), departments: listOf(buyer, "dept"), titles: listOf(buyer, "title"), countries: listOf(buyer, "location") },
    exclude: { industries: listOf(q.clauses, "industry", true), countries: listOf(q.clauses, "country", true), titles: listOf(buyer, "title", true) },
    ...custom.length ? { custom } : {}
  };
}
var fieldSlugs = (q) => q.clauses.flatMap((c) => c.key === "field" ? [c.slug] : []);

var countryLabel = (c) => COUNTRIES.find((x) => x.value === c)?.label ?? c.toUpperCase();
var levelLabel = (l) => LEVELS.find((x) => x.value === l)?.label ?? l;
var orList = (xs, word = "or") => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${word} ${xs[xs.length - 1]}`;
function bandsLabel(bands) {
  const idx = bands.map((b) => EMPLOYEE_BANDS.indexOf(b)).filter((i) => i >= 0).sort((a, b) => a - b);
  const runs = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  const lo = (i) => Number(EMPLOYEE_BANDS[i].split(/[-+]/)[0]).toLocaleString();
  const hi = (i) => EMPLOYEE_BANDS[i].endsWith("+") ? null : Number(EMPLOYEE_BANDS[i].split("-")[1]).toLocaleString();
  return runs.map(([a, b]) => hi(b) === null ? `${lo(a)}+` : `${lo(a)}–${hi(b)}`).join(", ");
}
function valueLabel(key, v, field) {
  switch (key) {
    case "industry":
      return industryLabel(v);
    case "country":
    case "location":
      return countryLabel(v);
    case "level":
      return levelLabel(v);
    case "size":
      return bandsLabel([v]);
    case "region":
      return REGIONS.find((r) => r.key === v)?.label ?? v;
    case "owner":
      return v === "none" ? "no one" : v;
    case "field":
      return field?.options?.find((o) => o.key === v)?.label ?? (v === "true" ? "Yes" : v === "false" ? "No" : v);
    default:
      return v;
  }
}
function clauseText(c, fields) {
  if (c.key === "field") {
    const f = fields.find((x) => x.slug === c.slug);
    if (!c.values) return c.min !== void 0 && c.max !== void 0 ? `${c.min}–${c.max}` : c.min !== void 0 ? `${c.min} or more` : `up to ${c.max}`;
    return orList(c.values.map((v) => valueLabel("field", v, f)));
  }
  if (c.key === "size") return bandsLabel(c.values);
  if (c.key === "title") return orList(c.values.map((v) => `“${v}”`), c.neg ? "or" : "or");
  return orList(c.values.map((v) => valueLabel(c.key, v)));
}
var fieldLabel = (slug, fields) => (fields.find((f) => f.slug === slug)?.label ?? slug).toLowerCase();
function companyPhrase(c, path, fields) {
  const t = { path, clause: c, text: clauseText(c, fields) };
  switch (c.key) {
    case "industry":
      return [c.neg ? "not in " : "in ", t];
    case "size":
      return ["with ", t, " employees"];
    case "country":
    case "region":
    case "city":
      return [c.neg ? "not based in " : "based in ", t];
    case "owner":
      return [c.neg ? "not owned by " : "owned by ", t];
    case "revenue":
      return ["with ", t, " in annual revenue"];
    case "field":
      return [`where ${fieldLabel(c.slug, fields)} is `, t];
    default:
      return [t];
  }
}
function personPhrase(clauses, has, fields, lead, buyer = false) {
  const at = (key, neg = false) => clauses.findIndex((c) => c.key === key && c.neg === neg);
  const tok = (i) => ({ path: { ...has !== void 0 ? { has } : {}, index: i }, clause: clauses[i], text: clauseText(clauses[i], fields) });
  const [li, di, ti, xi, gi] = [at("level"), at("dept"), at("title"), at("title", true), at("location")];
  const out = [];
  if (li >= 0) out.push(lead ? `${lead} ` : "", tok(li));
  else if (buyer && (di >= 0 || ti < 0)) out.push("a C-suite, VP, Head or Director");
  else out.push(lead === "no" ? "no one" : lead === "a" ? "someone" : "anyone");
  if (di >= 0) out.push(" in ", tok(di));
  if (ti >= 0) out.push(li >= 0 || di >= 0 ? ", or anyone titled " : " titled ", tok(ti));
  if (gi >= 0) out.push(", located in ", tok(gi));
  if (xi >= 0) out.push(", never anyone titled ", tok(xi));
  return out.filter((p) => p !== "");
}
var join = (groups, sep) => groups.flatMap((g, i) => i ? [sep, ...g] : g);
function sentence(kind, q, fields) {
  const company = q.clauses.map((c, index) => companyPhrase(c, { index }, fields));
  if (kind === "persona") return ["There, reach ", ...personPhrase(q.clauses, void 0, fields, ""), "."];
  if (kind === "segment") {
    const has = q.has.map((h, i) => h.neg ? ["with ", ...personPhrase(h.clauses, i, fields, "no")] : ["that employ ", ...personPhrase(h.clauses, i, fields, "a")]);
    const all = [...company, ...has];
    return all.length ? ["Of those, the ones ", ...join(all, " and "), "."] : ["All of its parent's accounts."];
  }
  const buyer = q.has.findIndex((h) => !h.neg);
  return [
    "Companies ",
    ...company.length ? join(company, ", ") : ["of any kind"],
    ", where ",
    ...buyer >= 0 ? personPhrase(q.has[buyer].clauses, buyer, fields, "a", true) : ["someone is C-suite, VP, Head or Director"],
    buyer >= 0 ? " works." : "."
  ];
}
var sentenceText = (parts) => parts.map((p) => typeof p === "string" ? p : p.text).join("");
function withValues(q, path, next) {
  const set = (cs) => cs.flatMap((c, i) => {
    if (i !== path.index) return [c];
    const merged = { ...c, ...next };
    const empty = merged.key === "field" ? !merged.values?.length && merged.min === void 0 && merged.max === void 0 : !merged.values.length;
    return empty ? [] : [merged];
  });
  const out = path.has === void 0 ? { ...q, clauses: set(q.clauses) } : { ...q, has: q.has.flatMap((h, i) => i !== path.has ? [h] : (() => {
    const cs = set(h.clauses);
    return cs.length ? [{ ...h, clauses: cs }] : [];
  })()) };
  return formatQuery(out);
}
function withClause(q, clause, where = {}) {
  if (where.newHas) return formatQuery({ ...q, has: [...q.has, { neg: where.newHas.neg, clauses: [clause] }] });
  if (where.has !== void 0) return formatQuery({ ...q, has: q.has.map((h, i) => i === where.has ? { ...h, clauses: [...h.clauses, clause] } : h) });
  return formatQuery({ ...q, clauses: [...q.clauses, clause] });
}

var options = {
  industry: INDUSTRIES.map((i) => ({ value: i.key, label: i.label })),
  country: COUNTRIES,
  location: COUNTRIES,
  size: EMPLOYEE_BANDS.map((value) => ({ value, label: value })),
  level: LEVELS,
  dept: DEPARTMENTS.map((value) => ({ value, label: value })),
  region: REGIONS.filter((r) => r.key !== "other").map((r) => ({ value: r.key, label: r.label }))
};
function accountFields(raw) {
  return raw.filter((f) => f.entity === "account").map((f) => {
    if (typeof f.id !== "string" || typeof f.label !== "string" || ![null, "text", "number", "boolean"].includes(f.answerType) || !(f.options === null || Array.isArray(f.options))) throw new Error("Account AI-field answer metadata is unavailable.");
    return { slug: f.id, label: f.label, answerType: f.answerType, options: f.options };
  });
}
function editorOptions(fields) {
  return { ...options, ...Object.fromEntries(fields.filter((f) => f.answerType === "boolean" || f.options !== null).map((f) => [`field-${f.slug}`, f.answerType === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : f.options.map((o) => ({ value: o.key, label: o.label }))])) };
}
function control(c, fields) {
  if (c.key === "field") {
    const f = fields.find((f2) => f2.slug === c.slug);
    if (!f) throw new Error(`field.${c.slug} is not one of this workspace's account AI fields.`);
    if (f.answerType === "number") return { kind: "range", ...c.min !== void 0 ? { min: c.min } : {}, ...c.max !== void 0 ? { max: c.max } : {} };
    const choices = f.answerType === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : f.options?.map((o) => ({ value: o.key, label: o.label }));
    return choices !== null && choices !== void 0 ? { kind: "choices", options: `field-${f.slug}`, values: c.values ?? [] } : { kind: "terms", values: c.values ?? [], placeholder: "An answer, then Enter" };
  }
  return c.key in options ? { kind: "choices", options: c.key, values: c.values } : { kind: "terms", values: c.values, placeholder: c.key === "title" ? c.neg ? "A word to never match, e.g. intern" : "A word in the title, then Enter" : "A value, then Enter" };
}
function addable(kind, q, fields) {
  const has = (cs, key, neg = false) => cs.some((c) => (c.key === "field" ? `field.${c.slug}` : c.key) === key && c.neg === neg);
  const list = (key, neg = false) => ({ key, neg, values: [] });
  const person = (cs, where, prefix) => [
    ["level", false, "seniority"],
    ["dept", false, "department"],
    ["title", false, "title contains"],
    ["title", true, "never titled"],
    ["location", false, "located in"]
  ].filter(([k, neg]) => !has(cs, k, neg)).map(([k, neg, label]) => ({ label: `${prefix}${label}`, clause: list(k, neg), where }));
  if (kind === "persona") return person(q.clauses, {}, "");
  const company = [
    ...[["industry", false, "Industry"], ["size", false, "Employees"], ["country", false, "Based in"], ["industry", true, "Never these industries"], ["country", true, "Never based in"]].filter(([k, neg]) => !has(q.clauses, k, neg)).map(([k, neg, label]) => ({ label, clause: list(k, neg), where: {} })),
    ...fields.filter((f) => !has(q.clauses, `field.${f.slug}`)).map((f) => ({ label: f.label, clause: { key: "field", slug: f.slug, neg: false, ...f.answerType === "number" ? {} : { values: [] } }, where: {} }))
  ];
  if (kind === "segment") return [
    ...company,
    ...[["region", false, "Region"], ["region", true, "Never this region"], ["city", false, "City"], ["owner", false, "Owner"], ["owner", true, "Never this owner"], ["revenue", false, "Annual revenue"]].filter(([k, neg]) => !has(q.clauses, k, neg)).map(([k, neg, label]) => ({ label, clause: list(k, neg), where: {} })),
    ...q.has.flatMap((h, i) => person(h.clauses, { has: i }, `${h.neg ? "Employs no one" : "Employs someone"} ${i + 1}: `)),
    ...q.has.length < 4 ? [{ label: "Employs someone who is…", clause: list("level"), where: { newHas: { neg: false } } }, { label: "Employs no one in…", clause: list("dept"), where: { newHas: { neg: true } } }] : []
  ];
  const buyer = q.has.findIndex((h) => !h.neg);
  return [...company, ...person(buyer >= 0 ? q.has[buyer].clauses : [], buyer >= 0 ? { has: buyer } : { newHas: { neg: false } }, "Buyer: ")];
}
var pathId = (p) => `${p.has === void 0 ? "own" : `has${p.has}`}-${p.index}`;
var addId = (a) => `${a.where.newHas ? `new${a.where.newHas.neg ? "Not" : "Has"}` : a.where.has !== void 0 ? `has${a.where.has}` : "own"}-${a.clause.neg ? "not-" : ""}${a.clause.key === "field" ? `field-${a.clause.slug}` : a.clause.key}`;
function editorValue(kind, text, fields, data) {
  const parsed = parseQuery(text, kind);
  const labels = { pointOfView: ["We believe", "What surprises them about their own problem"], offer: ["We'll offer", "One free thing a first email can send"], role: ["Role", "Champion, economic buyer…"] };
  const keys2 = kind === "icp" ? ["pointOfView", "offer"] : kind === "segment" ? ["pointOfView"] : ["offer", "role"];
  return {
    parts: parsed.errors.length ? ["Some saved conditions need review."] : sentence(kind, parsed.query, fields).map((p) => typeof p === "string" ? p : { id: pathId(p.path), text: p.text, negative: p.clause.neg || p.path.has !== void 0 && parsed.query.has[p.path.has].neg, control: control(p.clause, fields) }),
    conditions: parsed.errors.length ? [] : addable(kind, parsed.query, fields).map((a) => ({ id: addId(a), label: a.label, control: control(a.clause, fields) })),
    fields: keys2.map((key) => ({ key, label: labels[key][0], placeholder: labels[key][1], value: String(data[key] ?? ""), maxLength: key === "role" ? 40 : 400, rows: key === "role" ? 1 : 2 })),
    help: kind === "icp" ? "" : "Deal drafts still read the ICP's point of view and offer."
  };
}
function changeToken(kind, text, fields, change) {
  const parsed = parseQuery(text, kind);
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  const q = parsed.query;
  let clause, path, addition;
  if (change.add) {
    addition = addable(kind, q, fields).find((a) => addId(a) === change.id);
    if (!addition || change.remove) throw new Error("This condition is not available here.");
    clause = addition.clause;
  } else {
    const part = sentence(kind, q, fields).find((p) => typeof p !== "string" && pathId(p.path) === change.id);
    if (!part || typeof part === "string") throw new Error("This sentence value changed. Reload and try again.");
    clause = part.clause;
    path = part.path;
  }
  if (change.remove) return withValues(q, path, { values: [], min: void 0, max: void 0 });
  const c = control(clause, fields);
  let next;
  if (c.kind === "range") {
    if (change.values !== void 0 || change.min === void 0 && change.max === void 0 || ![change.min, change.max].every((n) => n === void 0 || Number.isFinite(n)) || change.min !== void 0 && change.max !== void 0 && change.min > change.max) throw new Error("Give a valid minimum or maximum.");
    next = { values: void 0, min: change.min, max: change.max };
  } else {
    if (!Array.isArray(change.values) || change.values.length > 60 || change.min !== void 0 || change.max !== void 0 || change.values.some((v) => typeof v !== "string" || !v.trim() || v.length > 120)) throw new Error("Choose valid condition values.");
    if (c.kind === "choices" && change.values.some((v) => !editorOptions(fields)[c.options].some((o) => o.value === v))) throw new Error("Choose a value from this condition's vocabulary.");
    if (change.add && !change.values.length) throw new Error("Choose a value first.");
    next = { values: change.values };
  }
  return addition ? withClause(q, { ...clause, ...next }, addition.where) : withValues(q, path, next);
}

function treeMoveError(nodes, sourceId, targetId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!source || !target) return "Row not found.";
  if (source.kind === "icp") return "Move a segment or persona, not an ICP.";
  if (target.kind === "persona") return "Personas cannot contain other rows.";
  if (source.parent === targetId) return "This row is already here.";
  const root = (id) => {
    const seen = /* @__PURE__ */ new Set();
    let node = byId.get(id);
    while (node?.parent) {
      if (seen.has(node.id)) return void 0;
      seen.add(node.id);
      node = byId.get(node.parent);
    }
    return node?.kind === "icp" ? node.id : void 0;
  };
  if (!root(sourceId) || root(sourceId) !== root(targetId)) return "Move rows within the same ICP.";
  for (const node of nodes) {
    let current = node;
    const seen = /* @__PURE__ */ new Set();
    let depth = 0;
    while (current && current.kind !== "icp") {
      if (seen.has(current.id)) return "A row cannot move inside itself or its descendants.";
      seen.add(current.id);
      depth++;
      current = byId.get(current.id === sourceId ? targetId : current.parent ?? "");
    }
    if (!current) return "Row not found.";
    if (depth > 4) return "Segments go at most 4 deep.";
  }
  return null;
}

function parseIcp(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`icp: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("icp: expected a JSON object");
  const icp = parsed;
  if (!icp.name || typeof icp.name !== "string") throw new Error('icp: missing "name"');
  if (!icp.persona || !icp.persona.titleKeywords?.length && !icp.persona.jobLevels?.length) {
    throw new Error('icp: "persona" needs at least titleKeywords or jobLevels (without them, scoring cannot rank fit)');
  }
  if (icp.motion === "investment" && !icp.investment?.thesisKeywords?.length && !icp.firmographics.industries?.length) {
    throw new Error("icp: investment motion needs investment.thesisKeywords or firmographics.industries");
  }
  return icp;
}
function employeeBandsToRange(bands) {
  if (!bands?.length) return {};
  let min;
  let max;
  let openTop = false;
  for (const band of bands) {
    const plus = /^(\d+)\+$/.exec(band.trim());
    if (plus) {
      const lo = Number(plus[1]);
      if (min === void 0 || lo < min) min = lo;
      openTop = true;
      continue;
    }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(band.trim());
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (min === void 0 || lo < min) min = lo;
      if (max === void 0 || hi > max) max = hi;
    }
  }
  return { min, max: openTop ? void 0 : max };
}

var INDUSTRY_RULES = [
  [/(saas|software|developer|devtools|platform|b2b tech)/, ["software development"]],
  [/(internet|online|marketplace|e-?commerce|web)/, ["technology, information and internet"]],
  [/(\bit\b|information technology|cloud|\bdata\b)/, ["it services and it consulting"]],
  [/(cyber|security)/, ["computer and network security"]],
  [/(fintech|financial|payments|lending|wealth)/, ["financial services"]],
  [/(invest|venture|private equity)/, ["investment management", "venture capital and private equity principals"]],
  [/bank/, ["banking"]],
  [/insur/, ["insurance"]],
  [/(marketing|advertising|agency)/, ["advertising services"]],
  [/media/, ["media production", "online audio and video media"]],
  [/(health|medical|hospital|clinic)/, ["hospitals and health care", "medical practices"]],
  [/(biotech|life science)/, ["biotechnology research"]],
  [/pharma/, ["pharmaceutical manufacturing"]],
  [/(staffing|recruit|talent)/, ["staffing and recruiting"]],
  [/(\bhr\b|human resources)/, ["human resources services"]],
  [/(consult|professional services|advisory)/, ["business consulting and services"]],
  [/(real estate|property|proptech)/, ["real estate"]],
  [/(retail|dtc|cpg|consumer goods)/, ["retail"]],
  [/(education|e-learning|edtech|learning)/, ["e-learning providers"]],
  [/(logistics|supply chain|freight|shipping)/, ["transportation, logistics, supply chain and storage"]],
  [/telecom/, ["telecommunications"]],
  [/wireless/, ["wireless services"]],
  [/construct/, ["construction"]],
  [/account/, ["accounting"]],
  [/(automotive|mobility)/, ["motor vehicle manufacturing"]],
  [/manufactur/, ["manufacturing"]],
  [/(legal|\blaw\b)/, ["law practice", "legal services"]],
  [/(hospitality|hotel)/, ["hospitality"]],
  [/restaurant/, ["restaurants"]],
  [/non-?profit/, ["non-profit organizations"]],
  [/(oil|gas)/, ["oil and gas"]],
  [/utilit/, ["utilities"]],
  [/gam(e|ing)/, ["computer games", "mobile gaming apps"]],
  [/(semiconductor|chip)/, ["semiconductor manufacturing"]],
  [/market research/, ["market research"]],
  [/(wholesale|distribut)/, ["wholesale"]],
  [/travel/, ["travel arrangements"]],
  [/(fitness|wellness)/, ["wellness and fitness services"]],
  [/(government|public sector)/, ["government administration"]]
];
function icpIndustriesToLeadsforge(industries) {
  const out = /* @__PURE__ */ new Set();
  for (const label of industries ?? []) {
    const canon = canonIndustry(label);
    if (canon) {
      out.add(canon);
      continue;
    }
    const l = label.toLowerCase().trim();
    for (const [re, mapped] of INDUSTRY_RULES) if (re.test(l)) mapped.forEach((m) => out.add(m));
  }
  return [...out];
}

var FILE_MAX_BYTES = 19 * 1024 * 1024;
var FILE_DEFAULT_BYTES = 10 * 1024 * 1024;

function textHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function normalizeCompanyWebsite(raw) {
  const candidate = raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`icp derive: "${raw}" is not a valid company website.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("icp derive supports only public HTTP websites.");
  const domain = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!domain.includes(".")) throw new Error(`icp derive: "${raw}" is not a public company domain.`);
  return { domain, url: `https://${domain}/` };
}

function publicPageUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("Use a public HTTPS page URL.");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Use a public HTTPS page without credentials or a port.");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || /(?:^|\.)(?:localhost|local|internal)$/.test(host) || /^[\d.]+$/.test(host)) throw new Error("Use a public HTTPS hostname.");
  url.hash = "";
  return url.toString();
}
function webPagesRequest(args) {
  if ("urls" in args) {
    if (Object.keys(args).some((k) => k !== "urls") || !Array.isArray(args.urls) || args.urls.length > 6) throw new Error("web.pages accepts at most six URLs, or one domain.");
    return { urls: [...new Set(args.urls.map(publicPageUrl))] };
  }
  if (Object.keys(args).some((k) => k !== "domain") || typeof args.domain !== "string" || args.domain.length > 2048) throw new Error("web.pages requires one company domain.");
  const raw = args.domain.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.username || url.password || url.port || !/^https?:$/.test(url.protocol)) throw new Error("Use a public HTTP(S) company domain without credentials or a port.");
  const { domain } = normalizeCompanyWebsite(raw);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.length > 253 || /(?:^|\.)(?:localhost|local|internal)$/.test(domain) || /^[\d.]+$/.test(domain)) throw new Error("Use a public company domain.");
  return { domain };
}

var industrySet = new Set(INDUSTRIES.map((i) => i.key));
var object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var strings = (v, max) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 120 && s === s.trim());
function freePopulationRequest(raw) {
  if (typeof raw !== "string" || raw.length > 1e4) throw new Error("A free search requires a bounded JSON query.");
  const q = JSON.parse(raw);
  if (!object(q) || Object.keys(q).some((k) => !["industries", "countries", "employeeMin", "employeeMax", "employeeBands", "buyer"].includes(k)) || !strings(q.industries, 3) || !q.industries.length || !q.industries.every((s) => industrySet.has(s)) || !strings(q.countries, 50)) throw new Error("Choose valid industries and countries for the free search.");
  for (const field of ["employeeMin", "employeeMax"]) if (q[field] !== void 0 && (!Number.isSafeInteger(q[field]) || Number(q[field]) < 1 || Number(q[field]) > 1e9)) throw new Error("Employee bounds must be positive integers.");
  if (q.employeeMin !== void 0 && q.employeeMax !== void 0 && Number(q.employeeMin) > Number(q.employeeMax)) throw new Error("Employee bounds are reversed.");
  if (q.employeeBands !== void 0 && (!strings(q.employeeBands, 20) || !q.employeeBands.every((b) => {
    const band = /^(\d+)(?:-(\d+)|\+)$/.exec(b);
    if (!band) return false;
    const min = Number(band[1]), max = band[2] ? Number(band[2]) : min;
    return Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 1 && max >= min && max <= 1e9;
  }))) throw new Error("Invalid employee bands.");
  if (!object(q.buyer) || Object.keys(q.buyer).sort().join() !== "departments,levels,titles" || !strings(q.buyer.levels, 20) || !strings(q.buyer.departments, 30) || !strings(q.buyer.titles, 40)) throw new Error("Invalid buyer criteria.");
  if (q.countries.length && q.countries.some((c) => !icpGeosToIso([c]).length)) throw new Error("Unknown country in the free search.");
  return {
    industries: q.industries,
    countries: q.countries,
    ...typeof q.employeeMin === "number" ? { employeeMin: q.employeeMin } : {},
    ...typeof q.employeeMax === "number" ? { employeeMax: q.employeeMax } : {},
    ...strings(q.employeeBands, 20) ? { employeeBands: q.employeeBands } : {},
    buyer: { levels: q.buyer.levels, departments: q.buyer.departments, titles: q.buyer.titles }
  };
}

var INDUSTRIES2 = INDUSTRIES.map((i) => i.key);
var MAX_PROPOSALS = 5;
var MAX_READ_URLS = 6;
var CRM_SOURCE = "canoncrm:data";
var clip = (s, n) => s.length > n ? `${s.slice(0, n)}…` : s;
var norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
function contextText(c) {
  const parts = [];
  if (c.vendorDomain) parts.push(`## Our company
${c.vendorDomain}`);
  if (c.sells.length) parts.push(`## What we sell / jobs we help with
${c.sells.map((j) => `- ${j}`).join("\n")}`);
  if (c.icp) parts.push(`## Our current ideal customer profile
${clip(JSON.stringify(c.icp), 3e3)}`);
  const facts = (d) => {
    const f = [d.account, d.industry, d.employees !== void 0 ? `${d.employees} employees` : void 0, d.amount !== void 0 ? `${d.currency ? `${d.currency} ` : "$"}${d.amount.toLocaleString("en-US")}` : void 0, d.country].filter(Boolean);
    return f.length ? ` (${f.join(", ")})` : "";
  };
  if (c.wonDeals.length) parts.push(`## Deals we won
${c.wonDeals.map((d) => `- ${d.name}${facts(d)}`).join("\n")}`);
  if (c.lostDeals.length) parts.push(`## Deals we lost
${c.lostDeals.map((d) => `- ${d.name}${facts(d)}`).join("\n")}`);
  if (c.bestAccounts.length) parts.push(`## Our best-fit accounts today
${c.bestAccounts.map((a) => `- ${a.name}${facts(a)}`).join("\n")}`);
  if (c.decided.length) {
    parts.push(`## Markets already considered (do not propose again)
${c.decided.map((d) => `- ${d.name} [${d.state}]${d.reason ? `: ${d.reason}` : ""}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
var PROPOSE_SCHEMA = {
  type: "object",
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: MAX_PROPOSALS,
      items: {
        type: "object",
        required: ["name", "rationale", "industries", "claims"],
        properties: {
          name: { type: "string", description: "2-6 words, e.g. 'Auto dealerships with commissioned sales staff'." },
          rationale: { type: "string", description: "One or two sentences: why this market would buy what we sell." },
          industries: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            description: "The closest industries, from the allowed list.",
            items: { type: "string", enum: [...INDUSTRIES2] }
          },
          employeeMin: { type: "number" },
          employeeMax: { type: "number" },
          countries: { type: "array", items: { type: "string" }, description: "Country names; omit to keep our current geography." },
          risks: { type: "array", maxItems: 3, items: { type: "string" }, description: "Why this might not work." },
          claims: {
            type: "array",
            maxItems: 4,
            description: "Each statement about this market or how it buys. Give `quote` + `sourceUrl` ONLY when copied word for word from a page or the CRM data below; otherwise leave them out and it will be shown as a hypothesis.",
            items: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" }, quote: { type: "string" }, sourceUrl: { type: "string" } }
            }
          },
          readUrls: {
            type: "array",
            maxItems: 2,
            description: "Public https pages (industry bodies, trade press, vendor pages) worth reading to check this market. We fetch them.",
            items: { type: "string" }
          }
        }
      }
    }
  }
};
function validIndustries(raw) {
  const allowed = new Set(INDUSTRIES2);
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((i) => norm(String(i))).filter((i) => allowed.has(i)))].slice(0, 3);
}
var num2 = (x) => typeof x === "number" && Number.isFinite(x) && x >= 1 && x <= 1e9 ? Math.round(x) : void 0;
var strings2 = (x, max, len) => (Array.isArray(x) ? x : []).filter((s) => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, len)).slice(0, max);
var marketKey = (industries) => [...industries].sort().join("|");
function parseProposals(raw, opts) {
  const list = raw?.proposals;
  if (!Array.isArray(list)) return [];
  const icpIndustries = new Set(opts.icp.companyIndustries?.include ?? []);
  const seenNames = new Set(opts.decided.map((d) => norm(d.name)));
  const seenKeys = new Set(opts.decided.map((d) => marketKey(d.industries)));
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_PROPOSALS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const s = item;
    const name = typeof s.name === "string" ? s.name.trim().slice(0, 80) : "";
    const industries = validIndustries(s.industries);
    if (!name || !industries.length || seenNames.has(norm(name))) continue;
    let employeeMin = num2(s.employeeMin);
    let employeeMax = num2(s.employeeMax);
    if (employeeMin !== void 0 && employeeMax !== void 0 && employeeMin > employeeMax) [employeeMin, employeeMax] = [employeeMax, employeeMin];
    const bandOutside = (() => {
      const r = opts.icp.companyEmployeeNumberRange;
      if (!r || employeeMin === void 0 && employeeMax === void 0) return false;
      return (employeeMax ?? Infinity) < (r.min ?? 1) || (employeeMin ?? 1) > (r.max ?? Infinity);
    })();
    if (industries.every((i) => icpIndustries.has(i)) && !bandOutside) continue;
    if (seenKeys.has(marketKey(industries))) continue;
    seenNames.add(norm(name));
    seenKeys.add(marketKey(industries));
    out.push({
      name,
      rationale: typeof s.rationale === "string" ? s.rationale.trim().slice(0, 500) : "",
      industries,
      ...employeeMin !== void 0 ? { employeeMin } : {},
      ...employeeMax !== void 0 ? { employeeMax } : {},
      countries: strings2(s.countries, 5, 60),
      risks: strings2(s.risks, 3, 240),
      claims: (Array.isArray(s.claims) ? s.claims : []).filter((c) => !!c && typeof c === "object").map((c) => c).filter((c) => typeof c.text === "string" && c.text.trim()).slice(0, 4).map((c) => ({
        text: String(c.text).trim().slice(0, 300),
        ...typeof c.quote === "string" && c.quote.trim() ? { quote: c.quote.trim().slice(0, 600) } : {},
        ...typeof c.sourceUrl === "string" ? { sourceUrl: c.sourceUrl.trim().slice(0, 500) } : {}
      })),
      readUrls: strings2(s.readUrls, 2, 500).filter((u) => /^https:\/\//i.test(u))
    });
  }
  return out;
}
function verifyClaims(claims, pages2) {
  return claims.map((c) => {
    const page = c.quote && c.quote.trim().length >= 12 ? pages2.find((p) => p.url === c.sourceUrl && p.text.includes(c.quote)) : null;
    return page && c.quote ? { text: c.text, quote: c.quote, sourceUrl: page.url } : { text: c.text };
  });
}
function addCited(proposals, cited, pages2) {
  const list = cited?.claims;
  if (!Array.isArray(list)) return proposals;
  const out = proposals.map((p) => ({ ...p, claims: [...p.claims] }));
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item;
    const target = typeof c.proposal === "number" ? out[c.proposal] : void 0;
    if (!target || target.claims.length >= 6 || typeof c.text !== "string") continue;
    const [verified] = verifyClaims([{ text: c.text.trim().slice(0, 300), ...typeof c.quote === "string" ? { quote: c.quote.trim().slice(0, 600) } : {}, ...typeof c.sourceUrl === "string" ? { sourceUrl: c.sourceUrl } : {} }], pages2);
    if (verified?.text) target.claims.push(verified);
  }
  return out;
}
function proposalSearch(p, icp) {
  const query = {
    industries: p.industries,
    countries: p.countries.length ? p.countries : icp?.firmographics.geos ?? [],
    ...p.employeeMin !== void 0 ? { employeeMin: p.employeeMin } : {},
    ...p.employeeMax !== void 0 ? { employeeMax: p.employeeMax } : {},
    ...!p.employeeMin && !p.employeeMax && icp?.firmographics.employeeBands?.length ? { employeeBands: icp.firmographics.employeeBands } : {},
    buyer: { levels: icp?.persona.jobLevels ?? [], departments: icp?.persona.departments ?? [], titles: icp?.persona.titleKeywords ?? [] }
  };
  return JSON.stringify(query);
}

var docs = (value) => value;
var expect = (collection, d) => ({ collection, key: d.key, version: d.version });
var waiting = (value, state) => {
  const run = value;
  if (!run || run.data.state !== state) throw new Error("This challenge is no longer waiting for this stage.");
  return run;
};
var move = (run, name) => ({ op: "transition", machine: "challenge", name, key: run.key });
var patch = (run, data) => ({ op: "patch", collection: "challenges", key: run.key, data, expect: [expect("challenges", run)] });
var context = (run) => JSON.parse(String(run.data.contextJson));
var pages = (value) => value;
var homeEvidence = (run) => [{ url: CRM_SOURCE, text: String(run.data.crmText) }, ...pages(run.data.homePages ?? [])];
var proposal = (market) => JSON.parse(String(market.data.proposalJson));
var claimsText = (p) => p.claims.map((c) => c.quote ? `${c.text}
Evidence: "${c.quote}" (${c.sourceUrl})` : `Hypothesis: ${c.text}`).join("\n\n") || "No supported claims.";
var marketData = (p) => ({ name: p.name, rationale: p.rationale, industries: p.industries, proposalJson: JSON.stringify(p), claimsText: claimsText(p), risksText: p.risks.join("\n"), sourcesText: [...new Set(p.claims.flatMap((c) => c.quote && c.sourceUrl ? [c.sourceUrl] : []))].join("\n") || "No verified sources" });
var safeUrls = (urls) => [...new Set(urls.flatMap((url) => {
  try {
    return [publicPageUrl(url)];
  } catch {
    return [];
  }
}))].slice(0, MAX_READ_URLS);
var challengeCalls = {
  startChallenge(ctx, reads) {
    const plan = reads.plan[0];
    if (!plan?.available) throw new Error("Connect ChatGPT in Integrations before challenging your ICP. This workflow uses your plan only.");
    const runs = docs(reads.runs).sort((a, b) => Number(b.data.startedAt) - Number(a.data.startedAt));
    const markets = docs(reads.markets);
    const active = runs.filter((r) => !["done", "failed"].includes(String(r.data.state)));
    if (active.some((r) => Number(r.data.startedAt) > ctx.now - 6e5)) throw new Error("A challenge is still running. Retry a stopped run after ten minutes.");
    const signup = reads.signup[0];
    const recent = new Set(runs.slice(0, 10).map((r) => r.key));
    const shaped = (rows, won) => rows.map((d) => {
      const company = d.company;
      return { name: typeof d.name === "string" ? d.name : "Unnamed opportunity", ...won && typeof d.amount === "number" && typeof d.currency === "string" ? { amount: d.amount / 100, currency: d.currency } : {}, ...typeof company?.name === "string" ? { account: company.name } : {}, ...typeof company?.industry === "string" ? { industry: company.industry } : {}, ...typeof company?.employees === "number" ? { employees: company.employees } : {} };
    });
    const c = {
      ...signup?.domain ? { vendorDomain: webPagesRequest({ domain: signup.domain }).domain } : {},
      ...signup?.icp ? { icp: signup.icp } : {},
      sells: signup?.sells ?? [],
      wonDeals: shaped(reads.won, true),
      lostDeals: shaped(reads.lost, false),
      bestAccounts: reads.best.map((a) => ({ name: typeof a.name === "string" ? a.name : "Unnamed account", ...typeof a.industry === "string" ? { industry: a.industry } : {}, ...typeof a.employees === "number" ? { employees: a.employees } : {}, ...typeof a.country === "string" ? { country: a.country } : {} })),
      decided: markets.filter((m) => recent.has(String(m.data.run)) && m.data.state !== "open").map((m) => ({ name: String(m.data.name), industries: m.data.industries, state: String(m.data.state), ...m.data.dismissReason ? { reason: String(m.data.dismissReason) } : {} }))
    };
    const key = `challenge-${ctx.now.toString(36)}-${textHash(ctx.caller.userId)}`;
    const prune = new Set(runs.slice(9).map((r) => r.key));
    const intents = [
      ...active.filter((r) => !prune.has(r.key)).map((r) => move(r, "expired")),
      ...markets.filter((m) => prune.has(String(m.data.run))).map((m) => ({ op: "delete", collection: "markets", key: m.key })),
      ...runs.filter((r) => prune.has(r.key)).map((r) => ({ op: "delete", collection: "challenges", key: r.key })),
      { op: "put", collection: "challenges", key, data: { name: "Challenge my ICP", startedBy: ctx.caller.userId, startedAt: ctx.now, domain: c.vendorDomain ?? "", contextJson: JSON.stringify(c), crmText: contextText(c), url: CRM_SOURCE, homeUrls: c.vendorDomain ? safeUrls([`https://${c.vendorDomain}/`]) : [], requestedUrls: [], searches: [], homePages: [], citationPages: [] }, expect: [...runs.map((r) => expect("challenges", r)), ...markets.map((m) => expect("markets", m)), { collection: "challenges", key, version: null }], expectCount: [{ collection: "challenges", count: runs.length }, { collection: "markets", count: markets.length }] },
      { op: "transition", machine: "challenge", name: "start", key }
    ];
    return { intents, value: { key } };
  },
  prepareChallenge(_ctx, reads) {
    const run = waiting(reads.run, "reading");
    return { intents: [patch(run, { homePages: reads.pages }), move(run, "propose")] };
  },
  refineChallenge(_ctx, reads) {
    const run = waiting(reads.run, "proposing");
    const c = context(run), icp = c.icp;
    const current = icp ? { companyIndustries: { include: icpIndustriesToLeadsforge(icp.firmographics.industries) }, companyEmployeeNumberRange: employeeBandsToRange(icp.firmographics.employeeBands) ?? void 0 } : {};
    const found = parseProposals({ proposals: run.data.proposals }, { icp: current, decided: c.decided }).map((p) => ({ ...p, countries: icpGeosToCountries(p.countries), readUrls: safeUrls(p.readUrls), claims: verifyClaims(p.claims, homeEvidence(run)) }));
    if (!found.length) throw new Error("The model proposed no usable markets outside your current ICP. Try again.");
    const searches = found.map((p) => {
      const q = proposalSearch(p, icp);
      freePopulationRequest(q);
      return q;
    });
    const intents = found.map((p, i) => ({ op: "put", collection: "markets", key: `${run.key}-${i}`, data: { ...marketData(p), run: run.key, position: i, search: searches[i] }, expect: [{ collection: "markets", key: `${run.key}-${i}`, version: null }] }));
    return { intents: [patch(run, { requestedUrls: safeUrls(found.flatMap((p) => p.readUrls)), searches }), ...intents, move(run, "readCitations")] };
  },
  readChallengeCitations(_ctx, reads) {
    const run = waiting(reads.run, "checking");
    const read = pages(reads.pages);
    return { intents: [patch(run, { citationPages: read }), move(run, read.length ? "cite" : "size")] };
  },
  finishCitations(_ctx, reads) {
    const run = waiting(reads.run, "citing");
    const markets = docs(reads.markets).filter((m) => m.data.run === run.key).sort((a, b) => Number(a.data.position) - Number(b.data.position));
    const cited = addCited(markets.map(proposal), { claims: run.data.citations }, pages(run.data.citationPages));
    return { intents: [patch(run, {}), ...markets.map((m, i) => ({ op: "patch", collection: "markets", key: m.key, data: marketData(cited[i]), expect: [expect("markets", m)] })), move(run, "size")] };
  },
  sizeChallenge(_ctx, reads) {
    const run = waiting(reads.run, "sizing");
    const sizes = new Map(reads.sizes.map((s) => [s.id, s]));
    const markets = docs(reads.markets).filter((m) => m.data.run === run.key);
    const intents = markets.map((m) => {
      const result = sizes.get(String(m.data.search));
      return { op: "patch", collection: "markets", key: m.key, data: { sizeText: result?.size ? `${result.size.capped ? "At least " : ""}${result.size.accounts.toLocaleString("en-US")} accounts${result.transport === "fake" ? " (test transport, no provider called)" : ""}` : "Size unavailable" }, expect: [expect("markets", m)] };
    });
    return { intents: [patch(run, {}), ...intents, move(run, "done")] };
  }
};

var KNOWN_COUNTRIES = new Set(COUNTRIES.map((c) => c.value));
function specFromIcp(icp) {
  return {
    market: {
      industries: icpIndustriesToLeadsforge(icp?.firmographics.industries),
      employeeBands: icp?.firmographics.employeeBands ?? [],
      countries: icpGeosToIso(icp?.firmographics.geos).map((c) => c.toLowerCase()).filter((c) => KNOWN_COUNTRIES.has(c))
    },
    persona: {
      levels: icp?.persona.jobLevels ?? [],
      departments: canonDepartments(icp?.persona.departments ?? []),
      titles: icp?.persona.titleKeywords ?? []
    },
    exclude: { industries: [], countries: [], titles: [] }
  };
}
var cleanSpecStrings = (values, max = 60) => [...new Set(values.map((s) => s.trim()).filter(Boolean))].slice(0, max).map((s) => s.slice(0, 120));
function cleanResearchSpec(spec) {
  const c = cleanSpecStrings;
  return {
    market: { industries: c(spec.market.industries), employeeBands: c(spec.market.employeeBands), countries: c(spec.market.countries) },
    persona: { levels: c(spec.persona.levels), departments: c(canonDepartments(spec.persona.departments)), titles: c(spec.persona.titles), countries: c(spec.persona.countries ?? []) },
    exclude: { industries: c(spec.exclude.industries), countries: c(spec.exclude.countries), titles: c(spec.exclude.titles) }
  };
}

function researchTree(spec) {
  const { query, errors } = parseQuery(specToQuery(spec), "icp");
  if (errors.length) throw new Error(errors.join("; "));
  return [
    { kind: "segment", name: "Target companies", query: formatQuery({ clauses: query.clauses, has: [] }) },
    ...query.has.filter((h) => !h.neg).map((h) => ({
      kind: "persona",
      name: "Buyers",
      parent: 0,
      query: formatQuery({ clauses: h.clauses, has: [] })
    }))
  ];
}

var IcpEvidenceError = class extends Error {
  constructor(verified, rejected) {
    super("icp derive: model returned fewer than two website-verifiable evidence quotes.");
    this.verified = verified;
    this.rejected = rejected;
  }
};
function strings3(value, max = 10) {
  return [...new Set((Array.isArray(value) ? value : []).filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, max);
}
function normalized(value) {
  return value.replace(/[\u2018\u2019\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u201f\u2033]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/\s+/g, " ").trim().toLowerCase();
}
function normalizeTriggerHypotheses(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item;
    const label = typeof row.label === "string" ? row.label.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const positiveEvidence = strings3(row.positiveEvidence, 12);
    const activeProjects = strings3(row.activeProjects, 10);
    if (!label || !positiveEvidence.length && !activeProjects.length) return [];
    const idRaw = typeof row.id === "string" ? row.id : label;
    const id = idRaw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `trigger-${index + 1}`;
    const allowed = /* @__PURE__ */ new Set(["job", "news", "company", "social", "review", "legal"]);
    const preferredSources = strings3(row.preferredSources, 6).filter((source) => allowed.has(source));
    return [{
      id,
      label,
      positiveEvidence,
      activeProjects,
      buyerFunctions: strings3(row.buyerFunctions, 10),
      negativeEvidence: strings3(row.negativeEvidence, 10),
      preferredSources
    }];
  }).slice(0, 5);
}
function normalizeWebsiteIcpModelResult(args) {
  const { raw } = args;
  const companyName = typeof raw.companyName === "string" ? raw.companyName.trim().slice(0, 100) : args.domain;
  const motion = raw.motion === "investment" ? "investment" : "sales";
  const icp = parseIcp(JSON.stringify({
    name: `Website-derived ICP for ${companyName}`,
    motion,
    ...motion === "investment" ? { investment: { stages: strings3(raw.investmentStages, 6), fundingAmounts: strings3(raw.fundingAmounts, 9), thesisKeywords: strings3(raw.thesisKeywords, 12) } } : {},
    firmographics: {
      industries: strings3(raw.industries, 6),
      employeeBands: strings3(raw.employeeBands, 8),
      geos: strings3(raw.geos, 8).map((value) => value.toLowerCase()),
      technologies: strings3(raw.technologies, 8).map((value) => value.toLowerCase())
    },
    persona: {
      jobLevels: strings3(raw.jobLevels, 8),
      departments: strings3(raw.departments, 8).map((value) => value.toLowerCase()),
      titleKeywords: strings3(raw.titleKeywords, 10)
    },
    signals: { intentTopics: strings3(raw.intentTopics, 10), triggerHypotheses: normalizeTriggerHypotheses(raw.triggerHypotheses) },
    scoring: { threshold: 0.6 }
  }));
  const evidence = [];
  const rejected = [];
  const haystacks = args.sources.map((source) => ({ ...source, text: normalized(source.text) }));
  for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (!item || typeof item !== "object") continue;
    const row = item;
    const quote = typeof row.quote === "string" ? row.quote.replace(/\s+/g, " ").trim() : "";
    if (!quote) continue;
    const needle = normalized(quote);
    const found = quote.length >= 12 ? [...haystacks].sort((a, b) => Number(b.id === row.source) - Number(a.id === row.source)).find((source) => source.text.includes(needle)) : void 0;
    if (!found) {
      rejected.push(quote);
      continue;
    }
    evidence.push({ label: typeof row.label === "string" ? row.label.slice(0, 80) : "Website evidence", excerpt: quote.slice(0, 320), sourceUrl: found.url });
  }
  if (evidence.length < 2) throw new IcpEvidenceError(evidence.length, rejected);
  const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  return {
    company: { name: companyName, domain: args.domain, summary: typeof raw.summary === "string" ? raw.summary.slice(0, 400) : "" },
    icp,
    evidence: evidence.slice(0, 6),
    confidence,
    derivation: { mode: "model", model: args.model }
  };
}

var researchCalls = {
  deriveFromWebsite(ctx) {
    const domain = webPagesRequest({ domain: ctx.args.domain }).domain;
    const key = `derive-${ctx.now.toString(36)}-${textHash(domain)}-${ctx.caller.userId}`;
    return { intents: [
      { op: "put", collection: "derivations", key, data: { domain, startedBy: ctx.caller.userId }, expect: [{ collection: "derivations", key, version: null }] },
      { op: "transition", machine: "websiteResearch", name: "start", key }
    ], value: { key } };
  },
  adoptDerived(ctx, reads) {
    const run = reads.derivation;
    if (!run || run.data.state !== "deriving") throw new Error("This website research is no longer waiting for adoption.");
    const raw = run.data.result;
    if (!raw) throw new Error("The model returned no research result.");
    const sources = run.data.sources;
    const evidence = raw.evidence;
    if (!Array.isArray(sources) || !Array.isArray(evidence) || evidence.length < 2 || !evidence.every((q) => q.quote.trim().length >= 12 && sources.some((s) => s.id === q.source && s.text.includes(q.quote)))) throw new Error("Research stopped because it has fewer than two exact website quotes.");
    const derived = normalizeWebsiteIcpModelResult({ domain: String(run.data.domain), sources, raw, model: String(run.data.model) });
    const spec = cleanResearchSpec(specFromIcp(derived.icp));
    const query = specToQuery(spec);
    const parsed = parseQuery(query, "icp");
    if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
    const definitions = reads.definitions;
    const key = run.key.replace(/^derive-/, "website-");
    const expect2 = [{ collection: "derivations", key: run.key, version: run.version }, ...definitions.map((d) => ({ collection: "icps", key: d.key, version: d.version })), { collection: "icps", key, version: null }];
    const company = derived.company.name;
    return { intents: [{
      op: "put",
      collection: "icps",
      key,
      data: { name: `${company.slice(0, 65)} (from website)`, description: derived.company.summary, query, spec: queryToSpec(parsed.query), source: "website", sourceDomain: run.data.domain, active: definitions.length === 0, isDefault: definitions.length === 0, createdAt: ctx.now },
      expect: expect2,
      expectCount: [{ collection: "icps", count: definitions.length }]
    }], value: { key } };
  },
  importResearch(ctx, reads) {
    const research = reads.signup[0];
    if (!research) throw new Error("There is no claimed signup research to import.");
    if (research.saved) throw new Error("This signup research has already been saved.");
    const definitions = reads.definitions;
    const key = `signup-${research.id}`;
    const intents = [{
      op: "put",
      collection: "icps",
      key,
      data: {
        name: `${research.domain.slice(0, 62)} (signup research)`,
        spec: research.spec,
        query: research.query,
        source: "research",
        sourceDomain: research.domain,
        active: !definitions.some((d) => d.data.active),
        isDefault: definitions.length === 0,
        createdAt: ctx.now
      },
      expect: [...definitions.map((d) => ({ collection: "icps", key: d.key, version: d.version })), { collection: "icps", key, version: null }],
      expectCount: [{ collection: "icps", count: definitions.length }]
    }];
    const nodes = reads.nodes;
    const tree = researchTree(research.spec);
    if (nodes.length + tree.length > 75) throw new Error("There is no room for the signup research's segments and personas.");
    for (const [index, { parent, ...node }] of tree.entries()) intents.push({ op: "put", collection: "nodes", key: `${key}-${index}`, data: {
      ...node,
      icp: key,
      ...parent !== void 0 ? { parent: `${key}-${parent}` } : {},
      createdAt: ctx.now
    }, expect: [{ collection: "nodes", key: `${key}-${index}`, version: null }] });
    intents[0].expectCount.push({ collection: "nodes", count: nodes.length });
    return { intents, value: { key, heuristic: research.heuristic } };
  }
};

var keys = { industry: "industry", notIndustry: "-industry", size: "size", country: "country", notCountry: "-country", region: "region", notRegion: "-region", city: "city", owner: "owner", notOwner: "-owner", revenue: "revenue", level: "level", dept: "dept", title: "title", notTitle: "-title", location: "location" };
var listField = { industry: "industries", size: "sizes", country: "countries", region: "regions", level: "levels", dept: "departments", location: "countries" };
function criteriaOf(q) {
  const clause = (c, group) => c.key === "field" ? { group, kind: c.values ? "answer" : "number", value: { slug: c.slug, ...c.values ? { answers: c.values } : {}, ...c.min !== void 0 ? { min: c.min } : {}, ...c.max !== void 0 ? { max: c.max } : {} } } : { group, kind: Object.keys(keys).find((k) => keys[k] === `${c.neg ? "-" : ""}${c.key}`), value: { [listField[c.key] ?? "values"]: c.values } };
  return [...q.clauses.map((c) => clause(c, 0)), ...q.has.flatMap((h, i) => h.clauses.map((c) => clause(c, h.neg ? -(i + 1) : i + 1)))];
}
function fromCriteria(c) {
  const clause = (c2) => {
    if (c2.kind === "answer" || c2.kind === "number") return { key: "field", slug: c2.value.slug, neg: false, ...c2.kind === "answer" ? { values: c2.value.answers ?? [] } : { ...c2.value.min !== void 0 ? { min: c2.value.min } : {}, ...c2.value.max !== void 0 ? { max: c2.value.max } : {} } };
    const key = keys[c2.kind];
    if (!key) throw new Error("Unknown condition.");
    const plain = key.replace(/^-/, "");
    return { key: plain, neg: key.startsWith("-"), values: c2.value[listField[plain] ?? "values"] ?? [] };
  };
  const groups = [...new Set(c.map((r) => r.group))];
  if (groups.some((g) => !Number.isInteger(g) || Math.abs(g) > 4)) throw new Error("A condition group is 0, or a people group from 1 to 4.");
  return { clauses: c.filter((r) => r.group === 0).map(clause), has: groups.filter((g) => g !== 0).map((g) => ({ neg: g < 0, clauses: c.filter((r) => r.group === g).map(clause) })) };
}
function queryOf(text, kind, fields) {
  if (text.length > 4e3) throw new Error("A query holds at most 4000 characters.");
  const parsed = parseQuery(text, kind);
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  for (const slug of fieldSlugs(parsed.query)) {
    const field = fields.find((f) => f.id === slug && f.entity === "account");
    if (!field) throw new Error(`field.${slug} is not one of this workspace's account AI fields.`);
    const c = parsed.query.clauses.find((c2) => c2.key === "field" && c2.slug === slug);
    if (c.min !== void 0 && c.max !== void 0 && c.min > c.max) throw new Error("A condition's minimum cannot exceed its maximum.");
    if (!c.values && field.answerType !== "number") throw new Error(`${slug} does not take a numeric range.`);
  }
  return { text: formatQuery(parsed.query), spec: queryToSpec(parsed.query), criteria: criteriaOf(parsed.query) };
}
var nameOf = (value) => {
  const name = String(value ?? "").trim();
  if (!name || name.length > 80) throw new Error("Give a name of 1 to 80 characters.");
  return name;
};
var messageOf = (v, max) => {
  const text = String(v ?? "").trim();
  if (text.length > max) throw new Error(`Keep this message within ${max} characters.`);
  return text;
};
function edit(command) {
  return (ctx, reads) => {
    const definitions = reads.definitions, nodes = reads.nodes;
    const fields = reads.fields;
    const all = [...definitions, ...nodes], rootKeys = new Set(definitions.map((d) => d.key));
    const taken = new Set(all.map((d) => d.key));
    let sequence = 0;
    const newKey = () => {
      let key2;
      do {
        key2 = `icp-${ctx.now.toString(36)}-${ctx.caller.userId}-${sequence++}`;
      } while (taken.has(key2));
      taken.add(key2);
      return key2;
    };
    const a = ctx.args, row = all.find((d) => d.key === a.key);
    const collection = row && rootKeys.has(row.key) ? "icps" : "nodes";
    const kind = collection === "icps" ? "icp" : row?.data.kind;
    if (command !== "create" && (!row || row.version !== a.expect)) throw new Error("This definition changed. Reload and try again.");
    const expect2 = all.map((d) => ({ collection: rootKeys.has(d.key) ? "icps" : "nodes", key: d.key, version: d.version }));
    const expectCount = [{ collection: "icps", count: definitions.length }, { collection: "nodes", count: nodes.length }];
    const intents = [];
    const patch2 = (d, data, unset) => intents.push({ op: "patch", collection: rootKeys.has(d.key) ? "icps" : "nodes", key: d.key, data, ...unset?.length ? { unset } : {} });
    const put = (collection2, key2, data) => {
      expect2.push({ collection: collection2, key: key2, version: null });
      intents.push({ op: "put", collection: collection2, key: key2, data });
    };
    const tree = () => all.map((d) => ({ id: d.key, parent: rootKeys.has(d.key) ? null : String(d.data.parent ?? d.data.icp), kind: rootKeys.has(d.key) ? "icp" : d.data.kind }));
    let key = row?.key;
    switch (command) {
      case "create": {
        const q = queryOf(String(a.query ?? ""), "icp", fields);
        key = newKey();
        put("icps", key, { name: nameOf(a.name), query: q.text, spec: q.spec, active: definitions.length === 0 || a.active === true, isDefault: definitions.length === 0, source: "manual", createdAt: ctx.now });
        break;
      }
      case "rename":
        patch2(row, { name: nameOf(a.name) });
        break;
      case "editQuery":
      case "editCriteria":
      case "editToken": {
        const text = command === "editToken" ? changeToken(kind, String(row.data.query), accountFields(fields), a.change) : command === "editQuery" ? String(a.query) : formatQuery(fromCriteria(a.criteria));
        const q = queryOf(text, kind, fields);
        patch2(row, { query: q.text, ...kind === "icp" ? { spec: q.spec } : {} });
        break;
      }
      case "messageField": {
        const allowed = { icp: ["pointOfView", "offer"], segment: ["pointOfView"], persona: ["role", "offer"] };
        const field = String(a.field);
        if (!allowed[kind].includes(field)) throw new Error("This message field is not available on this row.");
        const text = messageOf(a.value, field === "role" ? 40 : 400);
        patch2(row, text ? { [field]: text } : {}, text ? [] : [field]);
        break;
      }
      case "icpMessage":
      case "segmentMessage":
      case "personaMessage": {
        if (command !== `${kind}Message`) throw new Error("Choose the message editor for this row kind.");
        const data = {}, unset = [];
        const fields2 = { icp: ["description", "pointOfView", "offer"], segment: ["pointOfView"], persona: ["role", "offer"] };
        for (const f of fields2[kind]) {
          const text = messageOf(a[f], f === "role" ? 40 : f === "description" ? 2e3 : 400);
          if (text) data[f] = text;
          else unset.push(f);
        }
        patch2(row, data, unset);
        break;
      }
      case "toggle":
        if (kind !== "icp") throw new Error("Switch an ICP on or off.");
        patch2(row, { active: !row.data.active });
        break;
      case "setDefault":
        if (kind !== "icp") throw new Error("Choose an ICP as the default.");
        for (const d of definitions) if (d.data.isDefault !== (d.key === row.key)) patch2(d, { isDefault: d.key === row.key });
        break;
      case "duplicate": {
        if (kind !== "icp") throw new Error("Duplicate an entire ICP tree.");
        const children = nodes.filter((n) => n.data.icp === row.key);
        key = newKey();
        const mapping = new Map([[row.key, key], ...children.map((n) => [n.key, newKey()])]);
        const { gapCheck: _gap, updatedAt: _updated, ...data } = row.data;
        put("icps", key, { ...data, name: nameOf(`${String(data.name).slice(0, 73)} (copy)`), active: false, isDefault: false, createdAt: ctx.now });
        for (const child of children) put("nodes", mapping.get(child.key), { ...child.data, icp: key, ...child.data.parent ? { parent: mapping.get(String(child.data.parent)) } : {}, createdAt: ctx.now });
        break;
      }
      case "createNode": {
        if (kind === "persona") throw new Error("A persona has no segments or personas under it.");
        const nodeKind = a.kind;
        key = newKey();
        const root = kind === "icp" ? row.key : String(row.data.icp);
        const graph = [...tree(), { id: key, parent: root, kind: nodeKind }];
        if (row.key !== root) {
          const error = treeMoveError(graph, key, row.key);
          if (error) throw new Error(error);
        }
        const q = queryOf(nodeKind === "persona" ? "level:manager" : "", nodeKind, fields);
        put("nodes", key, { icp: root, ...kind === "segment" ? { parent: row.key } : {}, kind: nodeKind, name: nodeKind === "persona" ? "New persona" : "New segment", query: q.text, createdAt: ctx.now });
        break;
      }
      case "move": {
        if (kind === "icp") throw new Error("Move a segment or persona.");
        const error = treeMoveError(tree(), row.key, String(a.parent));
        if (error) throw new Error(error);
        patch2(row, a.parent === row.data.icp ? {} : { parent: a.parent }, a.parent === row.data.icp ? ["parent"] : []);
        break;
      }
      case "remove": {
        const doomed = /* @__PURE__ */ new Set([row.key]);
        for (let changed = true; changed; ) {
          changed = false;
          for (const n of nodes) if (doomed.has(String(n.data.parent ?? n.data.icp)) && !doomed.has(n.key)) {
            doomed.add(n.key);
            changed = true;
          }
        }
        for (const d of all.filter((d2) => doomed.has(d2.key))) intents.push({ op: "delete", collection: rootKeys.has(d.key) ? "icps" : "nodes", key: d.key });
        if (kind === "icp" && row.data.isDefault) {
          const next = definitions.filter((d) => d.key !== row.key).sort((a2, b) => Number(b.data.active) - Number(a2.data.active) || Number(a2.data.createdAt ?? a2.createdAt) - Number(b.data.createdAt ?? b.createdAt))[0];
          if (next) patch2(next, { isDefault: true });
        }
        break;
      }
      default:
        throw new Error("Unknown editing command.");
    }
    if (intents.length) {
      intents[0].expect = expect2;
      intents[0].expectCount = expectCount;
    }
    return { intents, value: { key } };
  };
}
var editingCalls = Object.fromEntries(["messageField", "editToken", "icpMessage", "segmentMessage", "personaMessage", "create", "rename", "editQuery", "editCriteria", "toggle", "setDefault", "duplicate", "createNode", "move", "remove"].map((name) => [name, edit(name)]));
var vocabulary = (_ctx, reads) => ({ value: {
  industries: INDUSTRIES.map((i) => ({ value: i.key, label: i.label })),
  countries: COUNTRIES,
  sizes: EMPLOYEE_BANDS.map((value) => ({ value, label: value })),
  levels: LEVELS,
  departments: DEPARTMENTS.map((value) => ({ value, label: value })),
  regions: REGIONS.filter((r) => r.key !== "other").map((r) => ({ value: r.key, label: r.label })),
  fields: reads.fields.filter((f) => f.entity === "account").map((f) => ({ value: f.id, label: f.label, answerType: f.answerType, options: f.answerType === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : f.options?.map((o) => ({ value: o.key, label: o.label })) ?? [] }))
} });
var validateQuery = (ctx, reads) => {
  const definitions = reads.definitions, nodes = reads.nodes;
  const row = [...definitions, ...nodes].find((d) => d.key === ctx.args.key);
  if (!row || row.version !== ctx.args.expect) return { value: { text: String(ctx.args.query), error: "This definition changed. Reload and try again." } };
  try {
    const kind = definitions.includes(row) ? "icp" : row.data.kind;
    return { value: { text: queryOf(String(ctx.args.query), kind, reads.fields).text } };
  } catch (e) {
    return { value: { text: String(ctx.args.query), error: e instanceof Error ? e.message : String(e) } };
  }
};

var gapLabels = { covered: "Covered", small: "Too small to fill", too_large: "Too large: narrow it", filling: "Filling", unavailable: "Unavailable", busy: "Busy" };
var calls = {
  ...editingCalls,
  ...researchCalls,
  ...challengeCalls,
  validateQuery,
  vocabulary,
  tree(_ctx, reads) {
    const definitions = [...reads.definitions].sort((a, b) => Number(b.data.isDefault) - Number(a.data.isDefault) || Number(a.data.createdAt ?? a.createdAt) - Number(b.data.createdAt ?? b.createdAt));
    const nodes = [...reads.nodes].sort((a, b) => Number(a.data.createdAt ?? a.createdAt) - Number(b.data.createdAt ?? b.createdAt));
    const counts = reads.counts;
    const fields = accountFields(reads.fields ?? []);
    const graph = [...definitions.map((d) => ({ id: d.key, parent: null, kind: "icp" })), ...nodes.map((d) => ({ id: d.key, parent: String(d.data.parent || d.data.icp), kind: d.data.kind }))];
    const byKey = new Map(counts.nodes.map((n) => [n.key, n]));
    const names = new Map([...definitions, ...nodes].map((d) => [d.key, String(d.data.name)]));
    const rows = [];
    const sets = [];
    const row = (d, depth, active, root = false) => {
      const count = byKey.get(d.key);
      if (!count) throw new Error(`No counts returned for ${d.data.name}`);
      const kind = root ? "icp" : d.data.kind;
      const parsed = parseQuery(String(d.data.query), kind);
      const editor = editorValue(kind, String(d.data.query), fields, d.data);
      const text = parsed.errors.length ? "Some saved conditions need review." : sentenceText(sentence(kind, parsed.query, fields));
      sets.push({
        key: d.key,
        parent: root ? null : d.data.parent || d.data.icp,
        label: d.data.name,
        kind: root ? "ICP" : kind === "segment" ? "Segment" : "Persona",
        count: count.accounts,
        active,
        accounts: count.accounts,
        people: count.people,
        size: kind === "persona" ? `${count.people.toLocaleString()} people at ${count.accounts.toLocaleString()} accounts` : `${count.accounts.toLocaleString()} accounts`,
        sentence: text,
        query: d.data.query,
        market: root ? count.market ?? null : null,
        marketText: root ? count.market == null ? "Unavailable" : count.market.toLocaleString() : "",
        pointOfView: d.data.pointOfView ?? "",
        offer: d.data.offer ?? "",
        role: d.data.role ?? ""
      });
      const addChoices = kind !== "persona" && depth < 4 ? [{ value: "segment", label: "+ Add segment" }, { value: "persona", label: "+ Add persona" }] : [];
      const moveTargets = root ? [] : graph.filter((g) => treeMoveError(graph, d.key, g.id) === null).map((g) => ({ value: g.id, label: names.get(g.id) }));
      rows.push({
        key: d.key,
        parent: root ? null : d.data.parent || d.data.icp,
        label: d.data.name,
        nameHint: kind === "persona" && d.data.role ? `${d.data.name} (${d.data.role})` : d.data.name,
        depth,
        icon: root ? "target" : kind === "segment" ? "layers" : "users",
        muted: !active,
        star: root && d.data.isDefault === true,
        sentence: text,
        editor,
        prefix: kind === "persona" ? "reach(" : root ? "" : ">",
        suffix: kind === "persona" ? ")" : "",
        addChoices,
        moveTargets,
        canAdd: addChoices.length > 0,
        canMove: moveTargets.length > 0,
        kind: root ? "ICP" : d.data.kind === "segment" ? "Segment" : "Persona",
        state: active ? "On" : "Off",
        query: d.data.query,
        definitionVersion: d.version,
        name: d.data.name,
        root: root ? d.key : d.data.icp,
        queryValid: parsed.errors.length === 0,
        queryError: parsed.errors.join("; "),
        criteria: parsed.errors.length ? null : criteriaOf(parsed.query),
        pointOfView: d.data.pointOfView ?? "",
        offer: d.data.offer ?? "",
        role: d.data.role ?? "",
        description: d.data.description ?? "",
        gap: root ? gapLabels[String(d.data.gapCheck?.outcome)] ?? "Not checked" : "",
        definition: d.data.description ?? d.data.role ?? "",
        accounts: count.accounts,
        people: count.people,
        canViewAccounts: root && active,
        overlaps: counts.overlaps.filter((o) => o.a === d.key || o.b === d.key).map((o) => `${names.get(o.a === d.key ? o.b : o.a)}: ${o.accounts}`).join(", ") || "None"
      });
      for (const child of nodes.filter((n) => (n.data.parent || n.data.icp) === d.key)) row(child, depth + 1, active);
    };
    for (const d of definitions) row(d, 0, d.data.active === true, true);
    if (rows.length !== definitions.length + nodes.length) throw new Error("Some ICP nodes have no readable parent");
    return { value: { rows, sets, editOptions: editorOptions(fields), parentsByIcp: rows.map((r) => ({ key: r.key, options: r.moveTargets })), overlaps: counts.overlaps.map((o) => ({ a: o.a, b: o.b, count: o.accounts })) } };
  }
};
export {
  calls
};

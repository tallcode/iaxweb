"""Export cached generic IPA data as a small Node runtime asset; no downloads."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
path = ROOT/'experiments/callsign-phonetics/text-distance.py'
spec = importlib.util.spec_from_file_location('cached_ipa', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lexicon = []
for word in module.INPUT['lexicon']:
    for phones in word['variants']:
        lexicon.append(dict(symbol=word['symbol'], word=word['word'], ipa=module.english(phones)))
for word in module.INPUT['chinese']:
    lexicon.append(dict(symbol=word['symbol'], word=word['spoken'], ipa=module.mandarin(word['pinyin'])))
lexicon.append(dict(symbol='Q', word='quebec', ipa='kɛbɛk'))
pinyin = {}
for key, value in module.PINYIN.items():
    try:
        pinyin[key] = module.segments(value)
    except ValueError:
        pinyin[key] = None
arpa = {key: module.segments(value) for key, value in module.ARPA.items()}
phones = sorted(set(p for values in [*[v for v in pinyin.values() if v is not None], *arpa.values(), *[module.segments(w['ipa']) for w in lexicon]] for p in values))
index = {phone: i for i, phone in enumerate(phones)}
def ids(values):
    return [index[value] for value in values]

data = dict(phones=phones, substitutions=[[module.substitution(a, b) for b in phones] for a in phones],
            pinyin={key: ids(value) if value is not None else None for key, value in pinyin.items()}, arpabet={key: ids(value) for key, value in arpa.items()},
            templates=[dict(symbol=w['symbol'], word=w['word'], phones=ids(module.segments(w['ipa']))) for w in lexicon])
folder = ROOT/'apps/backend/src/ai/phonetic-data'
folder.mkdir(exist_ok=True)
header = '''// Generated from cached Epitran/PanPhon MIT data and CMUdict pronunciations.
// Rebuild: python3 experiments/callsign-phonetics/export-near-data.py
// Generic explanation words only; no callsign identities or observed answers.
export interface NearPhoneData {
  phones: string[]
  substitutions: number[][]
  pinyin: Record<string, number[] | null>
  arpabet: Record<string, number[]>
  templates: { symbol: string, word: string, phones: number[] }[]
}
export const nearPhoneData: NearPhoneData = '''
(folder/'data.ts').write_text(header+json.dumps(data, ensure_ascii=False, separators=(',', ':'))+'\n')
cache = ROOT/'data/callsign-investigation/phonetic-research'
for name in ['panphon-LICENSE.txt', 'epitran-LICENSE.txt']:
    (folder/name).write_bytes((cache/name).read_bytes())
(folder/'cmudict-wrapper-LICENSE.txt').write_bytes((ROOT/'node_modules/@lunarisapp/cmudict/LICENSE').read_bytes())
(folder/'SOURCES.json').write_text(json.dumps(dict(generator='experiments/callsign-phonetics/export-near-data.py',
    note='MIT source notices included. Lexicon uses the existing @lunarisapp/cmudict dependency. No ASR corpus text or callsign lists are shipped.',
    existingDependency={'package': '@lunarisapp/cmudict', 'notice': 'cmudict-wrapper-LICENSE.txt', 'upstreamDictionary': 'https://github.com/cmusphinx/cmudict'},
    resources=json.loads((cache/'sources.json').read_text()), templates=len(lexicon), phones=len(phones)),ensure_ascii=False,indent=2)+'\n')
print('Exported',len(phones),'phone units,',len(lexicon),'generic templates; no network or model dependency.')

"""IPA feature-distance candidates from cached public CSVs, no model/network.

One insertion/deletion per word at most; feature substitutions have cost in
[0,1]. Distance is length-normalized, not a confidence or acoustic likelihood.
"""
import csv
import functools
import hashlib
import json
import math
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT/'data/callsign-investigation/phonetic-research'
OUT = CACHE/'text-hybrid-round1'
INPUT = json.loads((OUT/'input.json').read_text())


def csv_rows(name):
    with (CACHE/name).open() as stream:
        return list(csv.DictReader(stream))


PINYIN = {unicodedata.normalize('NFD', r['Orth']): unicodedata.normalize('NFD', r['Phon']) for r in csv_rows('cmn-Latn.csv')}
WEIGHTS = {key: float(value) for key, value in csv_rows('feature_weights.csv')[0].items()}
FEATURES = {unicodedata.normalize('NFD', r['ipa']): {key: {'+': 1, '-': -1, '0': 0}[r[key]] for key in WEIGHTS} for r in csv_rows('ipa_all.csv')}
BY_INITIAL = {}
for segment in sorted(FEATURES, key=len, reverse=True):
    BY_INITIAL.setdefault(segment[0], []).append(segment)
ARPA = {'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'aʊ̯', 'AY': 'aɪ̯', 'B': 'b', 'CH': 't͡ʃ', 'D': 'd', 'DH': 'ð', 'EH': 'ɛ',
        'ER': 'əɹ', 'EY': 'eɪ̯', 'F': 'f', 'G': 'ɡ', 'HH': 'h', 'IH': 'ɪ', 'IY': 'i', 'JH': 'd͡ʒ', 'K': 'k', 'L': 'l', 'M': 'm', 'N': 'n',
        'NG': 'ŋ', 'OW': 'oʊ̯', 'OY': 'ɔɪ̯', 'P': 'p', 'R': 'ɹ', 'S': 's', 'SH': 'ʃ', 'T': 't', 'TH': 'θ', 'UH': 'ʊ', 'UW': 'u', 'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ'}


def english(phones):
    return ''.join(ARPA[phone] for phone in phones)


def mandarin(syllables):
    output = ''
    for syllable in syllables:
        rest = unicodedata.normalize('NFD', syllable.replace('v', 'ü'))
        while rest:
            key = next((key for key in sorted(PINYIN, key=len, reverse=True) if rest.startswith(key)), None)
            if key is None:
                raise ValueError('Unmapped pinyin '+rest)
            output += PINYIN[key]
            rest = rest[len(key):]
    return output


@functools.lru_cache(None)
def segments(ipa):
    text, result = unicodedata.normalize('NFD', ipa), []
    while text:
        match = next((part for part in BY_INITIAL.get(text[0], []) if text.startswith(part)), None)
        if match is None:
            raise ValueError('Unmapped IPA '+text)
        result.append(match)
        text = text[len(match):]
    return tuple(result)


@functools.lru_cache(None)
def substitution(a, b):
    return sum(abs(FEATURES[a][key]-FEATURES[b][key])*weight for key, weight in WEIGHTS.items())/sum(WEIGHTS.values()) if a != b else 0


def distance(a, b):
    if abs(len(a)-len(b)) > 1:
        return math.inf, None
    # Two DP layers track structural edits. No unrestricted phone deletion.
    prev = [[math.inf, math.inf] for _ in range(len(b)+1)]
    prev[0][0] = 0
    if b:
        prev[1][1] = 1
    for i, source in enumerate(a, 1):
        current = [[math.inf, math.inf] for _ in range(len(b)+1)]
        if i == 1:
            current[0][1] = 1
        for j, target in enumerate(b, 1):
            value = substitution(source, target)
            current[j][0] = prev[j-1][0]+value
            current[j][1] = min(prev[j-1][1]+value, prev[j][0]+1, current[j-1][0]+1)
        prev = current
    edit = min(range(2), key=lambda index: prev[-1][index])
    return prev[-1][edit]/max(len(a), len(b), 1), edit


def main():
    sources = json.loads((CACHE/'sources.json').read_text())
    for row in sources:
        assert hashlib.sha256((CACHE/row['file']).read_bytes()).hexdigest() == row['sha256']
    lexicon = []
    for word in INPUT['lexicon']:
        for phones in word['variants']:
            lexicon.append(dict(symbol=word['symbol'], word=word['word'], ipa=english(phones), origin='cmudict'))
    for word in INPUT['chinese']:
        lexicon.append(dict(symbol=word['symbol'], word=word['spoken'], ipa=mandarin(word['pinyin']), origin='chinese-spelling'))
    lexicon.append(dict(symbol='Q', word='quebec', ipa='kɛbɛk', origin='cached-nato-standard'))
    for word in lexicon:
        word['segments'] = segments(word['ipa'])
    rows = []
    for query in INPUT['queries']:
        try:
            ipa = [mandarin(query['pinyin'])] if query['chinese'] else [english(phones) for phones in query['variants']]
            variants = [segments(item) for item in ipa]
        except ValueError as error:
            rows.append(dict(source=query['source'], ipa=[], ranked=[], abstention=str(error)))
            continue
        best = {}
        for candidate in lexicon:
            score, edits = min((distance(variant, candidate['segments']) for variant in variants), key=lambda row: row[0], default=(math.inf, None))
            if not math.isfinite(score):
                continue
            value = {key: val for key, val in candidate.items() if key != 'segments'}
            value.update(cost=score, structuralEdits=edits)
            if candidate['symbol'] not in best or score < best[candidate['symbol']]['cost']:
                best[candidate['symbol']] = value
        ranked = sorted(best.values(), key=lambda word: (word['cost'], word['symbol']))
        rows.append(dict(source=query['source'], ipa=ipa, ranked=ranked[:3], margin=ranked[1]['cost']-ranked[0]['cost'] if len(ranked) > 1 else None,
                         abstention='No reliable G2P or no candidate within one structural edit' if not ranked else None))
    result = dict(sourceSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), inputSha256=hashlib.sha256((OUT/'input.json').read_bytes()).hexdigest(),
                  usesAudio=False, usesCloud=False, maximumStructuralEdits=1, sources=sources, lexicon=[{key: value for key, value in word.items() if key != 'segments'} for word in lexicon], rows=rows)
    (OUT/'distances.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print('Scored', len(rows), 'word queries with', len(lexicon), 'generic pronunciation templates; no audio or cloud.')


if __name__ == '__main__':
    main()

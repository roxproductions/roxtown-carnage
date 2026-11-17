"""Generates public/voices.js: the announcer, the people on the street and the police: angry Irish and Scottish voices
(and a pirate), with real emotion.

How: each voice starts from a few seconds of a real Irish or Scottish speaker, made with Piper TTS (MIT) from the VCTK
voice (speakers of the CSTR VCTK Corpus, University of Edinburgh, CC BY 4.0) or the Scottish Alba voice (University of
Edinburgh, CC BY 4.0). Chatterbox TTS (Resemble AI, MIT) then speaks every line in that voice with its emotion
exaggeration turned up, so the anger is in the delivery. Chatterbox adds an inaudible watermark marking the audio as AI
generated.

  pip install chatterbox-tts piper-tts "setuptools<81"
  curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-vctk-medium.tar.bz2
  curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-alba-medium.tar.bz2
  (unpack both)
  python3 tools/make_voices.py path/to/en_GB-vctk-medium.onnx path/to/en_GB-alba-medium.onnx

Chatterbox downloads its model from Hugging Face on the first run. On a CPU it takes about 20 s a line, around an hour
for everything. Needs ffmpeg.
"""
import base64, json, os, random, subprocess, sys, tempfile, time, wave
import torch, torchaudio
from piper import PiperVoice, SynthesisConfig
from chatterbox.tts import ChatterboxTTS

VCTK, ALBA = sys.argv[1], sys.argv[2]
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'voices.js')
tmp = tempfile.mkdtemp()
random.seed(11); torch.manual_seed(11)
vctk = PiperVoice.load(VCTK)
alba = PiperVoice.load(ALBA)
SPK = json.load(open(VCTK + '.json'))['speaker_id_map']
cb = ChatterboxTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')

IRISH = {
    'hurt': ['Ah, feck!', 'Jaysus, me arm!', 'Ow! Ya eejit!'],
    'die': ['Ah, for feck\'s sake!', 'Ah no, not like this!', 'Mammy!'],
    'jacked': ['Oi! That\'s me car, ya gobshite!', 'Get back here with me car, ya thievin\' eejit!'],
    'jack': ['Get out of it!', 'Out! Now! Move yer arse!'],
    'taunt': ['Ha! Ya useless eejit!', 'Is that all ya\'ve got?'],
    'panic': ['Jaysus, run!', 'Holy God, help!', 'Mother of God!'],
}
SCOTS = {
    'hurt': ['Argh, ya wee bam!', 'Och, ma heid!', 'Ya numpty!'],
    'die': ['Ah, ya rotten swine!', 'Naw! Naw!', 'Och, that\'s me done!'],
    'jacked': ['Haw! That\'s ma motor, ya bampot!', 'Gie\'s ma car back, ya wee rocket!'],
    'jack': ['Get oot the motor!', 'Oot! Now!'],
    'taunt': ['Get it right up ye!', 'Ya absolute weapon!'],
    'panic': ['Run for it!', 'Help ma boab!', 'Polis! Somebody!'],
}
PIRATE = {
    'hurt': ['Arr, me leg!', 'Blast ye!', 'Shiver me timbers!'],
    'die': ['Arrgh! Davy Jones, here I come!', 'Me treasure! Noooo!', 'Abandon ship!'],
    'jacked': ['Oi! That be me ship, ye scurvy dog!', 'Thievin\' landlubber! Give it back!'],
    'jack': ['Out ye get, bilge rat!', 'This vessel be mine now!'],
    'taunt': ['Ha! Walk the plank!', 'Yo ho ho, ye scallywag!'],
    'panic': ['Man the lifeboats!', 'Run, ye swabs!', 'Mutiny!'],
}
# the people on the street: (who, VCTK speaker or None for Alba, lines, pitch factor)
PEOPLE = [
    ('Irish man, Dublin', 'p245', IRISH, 1.04), ('Scottish man, Glasgow', 'designed', None, 1.0),
    ('Posh London woman', 'designed', None, 1.0), ('Scottish woman, Edinburgh', None, SCOTS, 1.03),
    ('Irish man, Tipperary', 'p298', IRISH, 1.04), ('Scottish man, Fife', 'p237', SCOTS, 1.05),
    ('Irish woman, Dublin', 'designed', None, 1.0), ('Scottish woman, West Lothian', 'p264', SCOTS, 1.03),
    ('Irish man, Donegal', 'p364', IRISH, 1.04), ('Scottish man, Aberdeen', 'p263', SCOTS, 1.04),
    ('Pirate', 'pirate', PIRATE, 1.0),
]
COP = 'p285'        # Scottish man, Edinburgh
ANNOUNCER = 'p281'  # Scottish man, Edinburgh: deep, and pitched down further like a fight-game host

ANNOUNCE = {
    'wasted': 'Wasted!', 'carjacking': 'Car jackin\'!', 'frag': 'Frag!', 'roadkill': 'Road kill!',
    'win': 'Winner, ya legend!', 'newmatch': 'New match. Get tae it!', 'busted': 'Busted, ya numpty!',
    '0': 'Pistol!', '1': 'Dual pistols!', '2': 'Machine gun!', '3': 'Shotgun!', '4': 'Electro gun!',
    '5': 'Flame thrower!', '6': 'Rocket launcher!', '7': 'Grenades!', '8': 'Molotov cocktails!',
    '20': 'Health!', '21': 'Armour!', '22': 'Double damage!', '23': 'Invisibility!',
    '30': 'Vehicle machine gun!', '31': 'Oil slick!', '32': 'Car mines!', '33': 'Car jump!',
    # the car fist fight
    'round1': 'Round one!', 'round2': 'Round two!', 'round3': 'Final round!', 'roundx': 'Next round!',
    'fight': 'Fight!', 'finish': 'Finish him!', 'fatality': 'Fatality!', 'flawless': 'Flawless victory!',
    'victory': 'Victory!', 'brutal': 'Brutal!', 'excellent': 'Pure dead brilliant!', 'carcrush': 'Car crush!',
    'skyhigh': 'Sky high!', 'firestarter': 'Fire starter!', 'combo': 'Combo!',
    # race mode
    'race': 'Race on! Three laps, nae rules!', 'three': 'Three!', 'two': 'Two!', 'one': 'One!', 'go': 'Go! Go! Go!',
    'lastlap': 'Final lap! Floor it!', 'champ': 'Race winner! Get the bubbly oot!',
}
COP_LINES = {
    'spot': ['Polis! Stay where ye are!', 'There he is, the wee scrote!', 'Stop right there, pal!'],
    'arrest': ['You\'re nicked, pal!', 'Hands where I can see them, ya clown!'],
    'lost': ['Where\'d he go?', 'Lost the wee rat.'],
    'hurt': ['Officer down!', 'Argh, ma leg!'],
}


REF_TEXT = "Would ye look at the state of this place. I've been waiting here for twenty minutes and nobody has said a single word to me about it."
refs = {}


def ref(spk):
    """a few seconds of the speaker, for Chatterbox to take the voice and accent from"""
    if spk in refs: return refs[spk]
    path = os.path.join(tmp, 'ref_%s.wav' % (spk or 'alba'))
    if spk == 'pirate':
        # a gravelly old sea dog: the deepest Fife voice, slowed and pitched down
        raw = os.path.join(tmp, 'ref_raw.wav')
        with wave.open(raw, 'wb') as w:
            vctk.synthesize_wav(REF_TEXT, w, syn_config=SynthesisConfig(speaker_id=SPK['p237'], length_scale=1.1))
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af', 'asetrate=22050*0.86,aresample=22050', path], check=True)
    else:
        model, sid = (alba, None) if spk is None else (vctk, SPK[spk])
        with wave.open(path, 'wb') as w:
            model.synthesize_wav(REF_TEXT, w, syn_config=SynthesisConfig(speaker_id=sid))
    refs[spk] = path
    return path


def say(text, spk, exaggeration, cfg):
    # long silences or a runaway clip mean the model stumbled: try again
    for attempt in range(3):
        wav = cb.generate(text, audio_prompt_path=ref(spk), exaggeration=exaggeration, cfg_weight=cfg, temperature=0.85)
        secs = wav.shape[-1] / cb.sr
        if 0.3 < secs < 1.2 + len(text) * 0.12: break
    path = os.path.join(tmp, 'c.wav')
    torchaudio.save(path, wav, cb.sr)
    return path


def clip(text, spk, pitch, announcer=False):
    src = say(text, spk, 0.9 if announcer else 1.3, 0.5 if announcer else 0.3)
    mp3 = os.path.join(tmp, 'a.mp3')
    trim = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,'
    sr = cb.sr
    if announcer:  # a touch lower and bigger, like a fight-game host
        flt = trim + 'asetrate=%d,aresample=%d,atempo=%.4f,highpass=f=60,equalizer=f=2500:t=q:w=1:g=3,acompressor=threshold=-20dB:ratio=4:attack=5:release=90,' % (sr * 0.93, sr, 1 / 0.93)
    else:
        flt = trim + 'highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,'
    flt += 'loudnorm=I=-14:TP=-1.5:LRA=7'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', flt, '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', mp3], check=True)
    return base64.b64encode(open(mp3, 'rb').read()).decode()


t0 = time.time()
data = {'announcer': {}, 'people': [], 'cop': {}}
for key, text in ANNOUNCE.items():
    data['announcer'][key] = clip(text, ANNOUNCER, 1, announcer=True)
print('announcer', round(time.time() - t0), 's', flush=True)
old = None
if os.path.exists(OUT):
    js0 = open(OUT).read(); old = json.loads(js0[js0.index('{'):js0.rindex(';')])
for i, (name, spk, lines, pitch) in enumerate(PEOPLE):
    if spk == 'designed':  # made by tools/make_designed_voice.py (Qwen3-TTS VoiceDesign): keep what's there
        data['people'].append(old['people'][i] if old and i < len(old['people']) else {})
        continue
    data['people'].append({kind: [clip(t, spk, pitch) for t in ts] for kind, ts in lines.items()})
    print('person', name, round(time.time() - t0), 's', flush=True)
data['cop'] = {kind: [clip(t, COP, 1) for t in ts] for kind, ts in COP_LINES.items()}
print('cop', flush=True)
js = ('// Generated by tools/make_voices.py: Chatterbox TTS (Resemble AI, MIT) in voices made with Piper TTS from the VCTK and Alba voices\n'
      '// (University of Edinburgh, CC BY 4.0). The posh London woman, the Glaswegian and the Dublin woman: tools/make_designed_voice.py, Qwen3-TTS VoiceDesign (Apache 2.0).\n'
      'window.CC_VOICES = ' + json.dumps(data, separators=(',', ':')) + ';\n')
open(OUT, 'w').write(js)
print('wrote', OUT, round(len(js) / 1024), 'KB,', len(data['people']), 'people, in', round((time.time() - t0) / 60), 'min')

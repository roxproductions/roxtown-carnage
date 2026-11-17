"""Makes the designed voices: people whose voice comes from a written description with Qwen3-TTS VoiceDesign (Qwen,
Apache 2.0) instead of a real speaker: the posh London woman, the furious Glaswegian and the Dublin woman. Writes their
lines into public/voices.js, in their places among the people (make_voices.py keeps whatever is there for them).

  pip install qwen-tts            (its own environment: it pins a different transformers than Chatterbox)
  python3 tools/make_designed_voice.py              all of them
  python3 tools/make_designed_voice.py glasgow      just one (posh, glasgow, dublin)

Downloads Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign from Hugging Face (about 4 GB) on the first run. On a CPU it takes
roughly 20 s a line. Needs ffmpeg.
"""
import base64, json, os, subprocess, sys, tempfile
import torch, soundfile as sf
from qwen_tts import Qwen3TTSModel

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
POSH = {
    'hurt': ['Unhand me, you ghastly little man!', 'Ow! You utter brute!', 'Good heavens, my arm!'],
    'die': ['Oh, how frightfully common!', 'Not like this! Not in these shoes!', 'Mummy!'],
    'jacked': ['I say! That is MY car, you absolute oaf!', 'Bring back my Bentley, you ghastly little thief!'],
    'jack': ['Out you get, darling. Chop chop!', 'Move aside, peasant!'],
    'taunt': ['Is that honestly the best you can do?', 'Pathetic. Utterly pathetic.'],
    'panic': ['Oh, for heaven\'s sake!', 'Help! Somebody call Daddy!', 'Oh my giddy aunt!'],
}
# name: (their place in the people list of make_voices.py, the description, their lines)
VOICES = {
    'posh': (2, 'A very posh English woman from Kensington, London. Strong British accent, upper-class Received Pronunciation like '
             'the Royal Family, definitely not American. Clipped vowels, haughty, shrieking with indignant fury.', POSH),
    'glasgow': (1, 'A furious middle-aged Glaswegian man with a thick, rough Scottish accent, hoarse from shouting, red in the '
                'face, spitting with rage, yelling at someone who just stole his car.', SCOTS),
    'dublin': (6, 'An outraged young Dublin woman with a strong working-class Irish accent, screaming in fury, voice cracking '
               'with anger.', IRISH),
}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'voices.js')
tmp = tempfile.mkdtemp()
torch.set_num_threads(os.cpu_count())
model = Qwen3TTSModel.from_pretrained('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', device_map='cpu', dtype=torch.bfloat16, low_cpu_mem_usage=True)


def clip(text, n, desc):
    for attempt in range(3):  # a clip that runs on far too long means the model rambled: try again
        torch.manual_seed(1000 + n * 7 + attempt)
        wavs, sr = model.generate_voice_design(text=text, language='English', instruct=desc)
        if 0.3 < len(wavs[0]) / sr < 1.5 + len(text) * 0.11: break
    src, mp3 = os.path.join(tmp, 'c.wav'), os.path.join(tmp, 'c.mp3')
    sf.write(src, wavs[0], sr)
    trim = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,'
    flt = trim + 'highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,loudnorm=I=-14:TP=-1.5:LRA=7'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', flt, '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', mp3], check=True)
    print(round(len(wavs[0]) / sr, 1), 's', text, flush=True)
    return base64.b64encode(open(mp3, 'rb').read()).decode()


js = open(OUT).read()
head, data = js[:js.index('window.CC_VOICES = ')], json.loads(js[js.index('{'):js.rindex(';')])
for name in (sys.argv[1:] or list(VOICES)):
    slot, desc, table = VOICES[name]
    n, person = 0, {}
    for kind, lines in table.items():
        person[kind] = []
        for t in lines:
            person[kind].append(clip(t, n, desc)); n += 1
    data['people'][slot] = person
    open(OUT, 'w').write(head + 'window.CC_VOICES = ' + json.dumps(data, separators=(',', ':')) + ';\n')
    print('wrote', name, 'into place', slot, flush=True)

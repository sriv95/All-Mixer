# usage (cwd = work dir): prep_musdb.py -> decodes musdb7 stem.mp4 to clips_musdb/<name>/{mix,vocals}.wav; checks stream order and dupes vs set A
import pathlib, subprocess, glob, os, numpy as np, soundfile as sf
R=str(pathlib.Path(__file__).resolve().parents[3]/'spike/clips')+'/'
def dec(f,i):
    b=subprocess.run(['ffmpeg','-v','error','-i',f,'-map',f'0:{i}','-f','f32le','-ac','2','-ar','44100','-'],capture_output=True,check=True).stdout
    return np.frombuffer(b,np.float32).reshape(-1,2)
A={open(d+'/name.txt').read().strip():d for d in sorted(glob.glob(R+'wav/*'))}
files=sorted(glob.glob(R+'musdb7/*/*.stem.mp4')); dup=0; res=[]
for f in files:
    name=os.path.basename(f)[:-9]; s=[dec(f,i) for i in range(5)]
    n=min(len(x) for x in s); s=[x[:n].astype(np.float64) for x in s]
    res.append(10*np.log10((s[0]**2).sum()/((s[0]-sum(s[1:]))**2).sum()))
    if name in A:
        a,_=sf.read(A[name]+'/vocals.wav',dtype='float64'); m=min(len(a),n)
        d=10*np.log10((a[:m]**2).sum()/max(((a[:m]-s[4][:m])**2).sum(),1e-20))
        # vocals stream 4 vs set A vocals; also check other candidate streams
        alt=[10*np.log10((a[:m]**2).sum()/max(((a[:m]-s[i][:m])**2).sum(),1e-20)) for i in range(1,5)]
        if dup<3: print(name,'A-vocals vs streams1..4 SDR',np.round(alt,1))
        dup+=1; continue
    o=f'clips_musdb/{name}'; os.makedirs(o,exist_ok=True)
    sf.write(o+'/mix.wav',s[0].astype(np.float32),44100,subtype='FLOAT'); sf.write(o+'/vocals.wav',s[4].astype(np.float32),44100,subtype='FLOAT')
print('musdb total',len(files),'dropped dupes',dup,'kept',len(files)-dup,'A',len(A))
print('sum(1..4) vs mix SDR dB min/median',round(min(res),1),round(float(np.median(res)),1))

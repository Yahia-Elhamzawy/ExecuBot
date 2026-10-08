const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const tempAudioDir = path.resolve(__dirname, '../../../data/temp_audio');
if (!fs.existsSync(tempAudioDir)) {
  fs.mkdirSync(tempAudioDir, { recursive: true });
}

/**
 * تحويل النص إلى كلام وحفظه بصيغة MP3 ثم تحويله إلى OGG Opus المتوافق مع رسائل واتساب الصوتية (PTT)
 */
async function textToSpeechPTT(text, voice = 'ar-EG-ShakirNeural') {
  const timestamp = Date.now();
  const mp3Path = path.join(tempAudioDir, `tts_${timestamp}.mp3`);
  const oggPath = path.join(tempAudioDir, `ptt_${timestamp}.ogg`);

  return new Promise((resolve, reject) => {
    // 1. تشغيل edge-tts عبر بايثون
    const edgeTts = spawn('edge-tts', [
      '--voice', voice,
      '--text', text,
      '--write-media', mp3Path
    ]);

    edgeTts.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`edge-tts فشل بكود خروج: ${code}`));
      }

      // 2. تحويل MP3 إلى OGG Opus متوافق مع WhatsApp PTT
      let ffmpegPath = 'ffmpeg';
      try {
        const installer = require('@ffmpeg-installer/ffmpeg');
        if (installer && installer.path) {
          ffmpegPath = installer.path;
        }
      } catch (e) {}

      const ffmpeg = spawn(ffmpegPath, [
        '-i', mp3Path,
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-vbr', 'on',
        '-compression_level', '10',
        oggPath
      ]);

      ffmpeg.on('close', (fCode) => {
        try {
          if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        } catch (e) {}

        if (fCode === 0 && fs.existsSync(oggPath)) {
          resolve(oggPath);
        } else {
          // في حال فشل تحويل OGG، نعيد مسار MP3 إذا كان متاحاً
          if (fs.existsSync(mp3Path)) resolve(mp3Path);
          else reject(new Error(`ffmpeg فشل بكود خروج: ${fCode}`));
        }
      });

      ffmpeg.on('error', (err) => {
        console.warn('ffmpeg غير متوفر أو واجه خطأ، سيتم إرسال MP3 مباشرة:', err.message);
        resolve(mp3Path);
      });
    });

    edgeTts.on('error', (err) => {
      reject(new Error(`فشل استدعاء edge-tts: ${err.message}`));
    });
  });
}

module.exports = {
  textToSpeechPTT
};

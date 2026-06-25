import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { resolveApiUrl } from '../utils/resolveApiUrl';
import {
  BUCKET_IDS,
  BUCKET_META,
  bucketLabel,
  inferDominantBucketYolo5,
} from '../utils/ecoScenarioMap';
import { speakScenario } from '../utils/scenarioSpeech';

/** 与 eco_static/garbage/{类别}/1~3.jpg 对齐（可用真实照片替换占位图） */
function buildSlides() {
  const cats = [
    ['recyclable', '可回收'],
    ['kitchen', '厨余'],
    ['harmful', '有害'],
    ['other', '其它'],
  ];
  return cats.flatMap(([folder, name]) =>
    [1, 2, 3].map((n) => ({
      id: `${folder}-${n}`,
      folder,
      file: `${n}.jpg`,
      caption: `${name} · 演示图 ${n}`,
    }))
  );
}

const SPEEDS = [
  { ms: 2000, label: '快（2 秒/张）' },
  { ms: 3000, label: '中（3 秒/张）' },
  { ms: 5000, label: '慢（5 秒/张）' },
];

export default function ScenarioCarouselPage() {
  const slides = useMemo(() => buildSlides(), []);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const intervalMs = SPEEDS[speedIdx].ms;

  const [selectedBucket, setSelectedBucket] = useState(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);
  const voicePrimedRef = useRef(false);
  const expectedBucketRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [annotatedUrl, setAnnotatedUrl] = useState('');
  const [detections, setDetections] = useState([]);
  const [overall, setOverall] = useState('');
  const [inferred, setInferred] = useState(null);

  const [judge, setJudge] = useState('idle');
  const judgeRef = useRef('idle');
  useEffect(() => {
    judgeRef.current = judge;
  }, [judge]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  const selectBucket = (id) => {
    voicePrimedRef.current = true;
    setSelectedBucket(id);
    queueMicrotask(() => {
      if (!voiceEnabledRef.current) return;
      const exp = expectedBucketRef.current;
      if (exp == null) {
        speakScenario('当前暂未识别出明确四类垃圾类别，请选择最接近的垃圾桶。');
        return;
      }
      if (id === exp) {
        speakScenario('投放正确！请继续保持垃圾分类好习惯。');
      } else {
        speakScenario(`投放错误！模型判断为${bucketLabel(exp)}，请投入对应垃圾桶。`);
      }
    });
  };

  const slide = slides[index];

  const detectionSeqRef = useRef(0);

  const runDetectionForSlide = useCallback(async () => {
    if (!slide) return;
    const seq = ++detectionSeqRef.current;
    setLoading(true);
    setErrMsg('');
    setAnnotatedUrl('');
    setDetections([]);
    setOverall('');
    setInferred(null);
    setJudge('idle');
    const path = `/eco_static/garbage/${slide.folder}/${slide.file}`;
    try {
      const imgRes = await fetch(path, { credentials: 'include' });
      if (detectionSeqRef.current !== seq) return;
      if (!imgRes.ok) {
        throw new Error(`无法加载演示图（${imgRes.status}）：请确认后端已启动且存在 ${path}`);
      }
      const blob = await imgRes.blob();
      if (detectionSeqRef.current !== seq) return;
      const file = new File([blob], `${slide.id}.jpg`, { type: blob.type || 'image/jpeg' });
      const form = new FormData();
      form.append('file', file);
      const { data } = await api.post('/api/detect', form);
      if (detectionSeqRef.current !== seq) return;
      if (data.status !== 'success') {
        throw new Error(data.message || '检测接口返回失败');
      }
      setDetections(data.results || []);
      setOverall(data.message || '');
      const inf = inferDominantBucketYolo5(data.results || []);
      setInferred(inf);
      if (data.result_url) setAnnotatedUrl(resolveApiUrl(data.result_url));
    } catch (e) {
      if (detectionSeqRef.current !== seq) return;
      const msg = e.response?.data?.message || e.message || '检测失败';
      setErrMsg(msg);
    } finally {
      if (detectionSeqRef.current === seq) setLoading(false);
    }
  }, [slide]);

  useEffect(() => {
    setSelectedBucket(null);
    runDetectionForSlide();
  }, [index, runDetectionForSlide]);

  useEffect(() => {
    if (!isPlaying || slides.length === 0) return undefined;
    const t = window.setInterval(() => {
      setIndex((i) => (i + 1) % slides.length);
    }, intervalMs);
    return () => window.clearInterval(t);
  }, [isPlaying, intervalMs, slides.length]);

  const expectedBucket = inferred?.bucket ?? null;

  useEffect(() => {
    expectedBucketRef.current = expectedBucket;
  }, [expectedBucket]);

  useEffect(() => {
    if (selectedBucket == null || expectedBucket == null) {
      setJudge('idle');
      return;
    }
    setJudge(selectedBucket === expectedBucket ? 'correct' : 'wrong');
  }, [selectedBucket, expectedBucket]);

  useEffect(() => {
    if (!voiceEnabledRef.current || selectedBucket != null) return undefined;
    if (!expectedBucket || loading || errMsg) return undefined;
    const t = window.setTimeout(() => {
      if (judgeRef.current !== 'idle') return;
      if (!voicePrimedRef.current) return;
      speakScenario(
        `请根据画面选择垃圾桶，模型建议投入${bucketLabel(expectedBucket)}。`,
      );
    }, 10000);
    return () => window.clearTimeout(t);
  }, [index, selectedBucket, expectedBucket, loading, errMsg]);

  const goPrev = () => {
    voicePrimedRef.current = true;
    setIsPlaying(false);
    setIndex((i) => (i - 1 + slides.length) % slides.length);
  };

  const goNext = () => {
    voicePrimedRef.current = true;
    setIsPlaying(false);
    setIndex((i) => (i + 1) % slides.length);
  };

  const onReset = () => {
    voicePrimedRef.current = true;
    setIsPlaying(false);
    setSelectedBucket(null);
    setJudge('idle');
    setIndex(0);
  };

  const confText =
    inferred?.topConf != null ? `${(Number(inferred.topConf) * 100).toFixed(1)}%` : inferred?.bucket ? '（综合推断）' : '—';

  return (
    <div className="page-container eco-page scenario-carousel-page">
      <div className="container eco-narrow">
        <div className="d-flex flex-wrap align-items-end justify-content-between gap-3 mb-4">
          <div>
            <p className="eco-eyebrow mb-1">YOLOv5 · 场景演练</p>
            <h1 className="h3 mb-0 text-white">图片轮播 · 模拟垃圾投放</h1>
            <p className="text-muted small mb-0 mt-2">
              与「识别工作台」相同，轮播每张图会自动调用{' '}
              <code className="text-success">POST /api/detect</code>（四类生活垃圾专用模型）；点选垃圾桶后对照模型结果判定对错。若听不到语音请先点{' '}
              <strong className="text-white-50">试听语音</strong>（Chrome 需手动激活朗读）。
            </p>
          </div>
          <Link className="btn btn-outline-light btn-sm rounded-pill px-3" to="/">
            返回总览
          </Link>
        </div>

        <div className="eco-glass p-3 p-md-4 mb-4">
          <div className="row g-3 mb-3">
            {BUCKET_IDS.map((id) => {
              const m = BUCKET_META[id];
              const active = selectedBucket === id;
              return (
                <div key={id} className="col-6 col-md-3">
                  <button
                    type="button"
                    className={`btn w-100 py-3 rounded-4 border scenario-bucket-btn ${active ? 'scenario-bucket-active' : ''}`}
                    style={{
                      borderColor: 'rgba(148,163,184,0.35)',
                      background: active ? `${m.color}33` : 'rgba(15,23,42,0.5)',
                      color: '#f8fafc',
                    }}
                    onClick={() => selectBucket(id)}
                  >
                    <span className="d-block fw-bold">{m.label}</span>
                    <small className="text-white-50">{m.hint}</small>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="ratio ratio-4x3 rounded-4 overflow-hidden border border-secondary border-opacity-25 bg-black position-relative mb-3">
            {annotatedUrl ? (
              <img src={annotatedUrl} alt="检测结果" className="w-100 h-100 object-fit-contain" />
            ) : (
              <div className="d-flex align-items-center justify-content-center text-secondary small p-3 text-center">
                {loading ? '正在检测当前画面…' : errMsg || '等待加载'}
              </div>
            )}
            {loading && (
              <div className="position-absolute top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center scenario-loading-overlay">
                <div className="spinner-border text-light" role="status">
                  <span className="visually-hidden">加载中</span>
                </div>
              </div>
            )}
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
            <button
              type="button"
              className="btn btn-success btn-sm rounded-pill px-3"
              onClick={() => {
                voicePrimedRef.current = true;
                setIsPlaying(true);
              }}
              disabled={isPlaying}
            >
              开始轮播
            </button>
            <button
              type="button"
              className="btn btn-outline-light btn-sm rounded-pill px-3"
              onClick={() => setIsPlaying(false)}
              disabled={!isPlaying}
            >
              停止
            </button>
            <button type="button" className="btn btn-outline-secondary btn-sm rounded-pill px-3" onClick={onReset}>
              复位（回到首张）
            </button>
            <button type="button" className="btn btn-outline-secondary btn-sm rounded-pill px-3" onClick={goPrev}>
              上一张
            </button>
            <button type="button" className="btn btn-outline-secondary btn-sm rounded-pill px-3" onClick={goNext}>
              下一张
            </button>

            <div className="ms-md-auto d-flex align-items-center gap-2">
              <label className="small text-muted mb-0">轮播速度</label>
              <select
                className="form-select form-select-sm eco-select-dark"
                style={{ width: 'auto' }}
                value={speedIdx}
                onChange={(e) => setSpeedIdx(Number(e.target.value))}
              >
                {SPEEDS.map((s, i) => (
                  <option key={s.ms} value={i}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-outline-light btn-sm rounded-pill px-3"
                onClick={() => {
                  voicePrimedRef.current = true;
                  voiceEnabledRef.current = true;
                  setVoiceEnabled(true);
                  speakScenario('语音试听正常，垃圾分类投放演练已就绪。', { enabled: true });
                }}
              >
                试听语音
              </button>
              <button
                type="button"
                className={`btn btn-sm rounded-pill px-3 ${voiceEnabled ? 'btn-info' : 'btn-outline-info'}`}
                onClick={() => setVoiceEnabled((v) => !v)}
              >
                {voiceEnabled ? '语音：开' : '语音：关'}
              </button>
            </div>
          </div>

          <div className="small text-secondary mb-2">
            当前第 <strong className="text-white">{index + 1}</strong> / {slides.length} 张 · {slide?.caption}
          </div>

          {errMsg && <div className="alert alert-danger py-2 small mb-3">{errMsg}</div>}

          <div className="scenario-panel p-3 rounded-4">
            <div className="row g-2 small">
              <div className="col-md-6">
                <span className="text-muted">模型关注点：</span>{' '}
                <strong className="text-white">{inferred?.topClass || '—'}</strong>
              </div>
              <div className="col-md-6">
                <span className="text-muted">推断投放桶：</span>{' '}
                <strong className="text-white">{expectedBucket ? bucketLabel(expectedBucket) : '暂无'}</strong>
              </div>
              <div className="col-md-6">
                <span className="text-muted">置信度：</span>{' '}
                <strong className="text-white">{confText}</strong>
              </div>
              <div className="col-md-6">
                <span className="text-muted">识别摘要：</span>{' '}
                <strong className="text-white">{overall || '—'}</strong>
              </div>
            </div>

            <hr className="border-secondary opacity-25 my-3" />

            <div
              className={`scenario-judge fw-semibold ${
                judge === 'correct' ? 'text-success' : judge === 'wrong' ? 'text-danger' : 'text-secondary'
              }`}
            >
              {selectedBucket == null && <span>投放判定：未选择垃圾桶（未投放）</span>}
              {selectedBucket != null && expectedBucket == null && (
                <span>投放判定：当前画面难以可靠分类，选择仅供参考</span>
              )}
              {selectedBucket != null && expectedBucket != null && judge === 'correct' && (
                <span>投放判定：正确（已选 {bucketLabel(selectedBucket)}）</span>
              )}
              {selectedBucket != null && expectedBucket != null && judge === 'wrong' && (
                <span>
                  投放判定：错误（已选 {bucketLabel(selectedBucket)}，建议 {bucketLabel(expectedBucket)}）
                </span>
              )}
            </div>
          </div>
        </div>

        <p className="small text-secondary mb-2">
          语音提示：请先点击「试听语音」或「开始轮播」解锁浏览器朗读；静音时请检查系统音量与 Edge/Chrome 站点权限。
        </p>
        <p className="small text-secondary">
          演示图：<code className="text-secondary">eco_static/garbage/</code> 四子目录各 1~3.jpg（可换成真实生活垃圾照片以提升{' '}
          <code>/api/detect</code> 准确率）。
        </p>
      </div>
    </div>
  );
}

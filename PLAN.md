# Temporal Conflict-Aware Memory for Long-Horizon Assistants

## Summary
- Konu: genel amaçlı bir assistant için, zamanla değişen ve birbiriyle çelişebilen bilgileri yöneten `temporal + conflict-aware` bir long-term memory katmanı tasarlamak.
- Hedef çıktı: İngilizce `arXiv-style technical report` + açık kaynak repo + tekrar üretilebilir deney düzeni.
- Konumlandırma: yeni model eğitmek yerine, senin mevcut güçlü alanlarına yaslanan bir sistem/pipeline katkısı üretmek. Özellikle [vectra](https://github.com/tahsinkoc/vectra), [embrix](https://github.com/tahsinkoc/embrix) ve [instruction-bot](https://github.com/tahsinkoc/instruction-bot) bu yönü destekliyor.
- Literatür dayanağı: plan, özellikle [LongMemEval](https://arxiv.org/abs/2410.10813), [LoCoMo](https://arxiv.org/abs/2402.17753), [A-MEM](https://arxiv.org/abs/2502.12110), [ES-MemEval](https://arxiv.org/abs/2602.01885) ve [EverMemBench](https://arxiv.org/abs/2602.01313) etrafında kurulacak.

## Planned Markdown Set
- `docs/research/00_index.md`: tüm araştırma klasörünün kısa rehberi ve belge ilişkileri.
- `docs/research/01_topic.md`: problem tanımı, araştırma sorusu, hipotez, katkı iddiası, neden bu konu.
- `docs/research/02_related_work.md`: ilgili işler ve açık boşluklar; özellikle temporal reasoning, knowledge updates, conflict detection, abstention.
- `docs/research/03_system_design.md`: memory mimarisi, veri akışı, karar mantığı, retrieval ve abstention politikası.
- `docs/research/04_experiment_design.md`: benchmark seçimi, baseline’lar, metrikler, ablation planı, maliyet/bütçe.
- `docs/research/05_synthetic_extension.md`: küçük özgün sentetik temporal-conflict test seti üretim kuralları ve kalite kontrolü.
- `docs/research/06_results_template.md`: tablo şablonları, hata analizi formatı, claim checklist.
- `docs/research/07_paper_outline.md`: başlık seçenekleri, abstract iskeleti, bölüm planı, figür/tablo listesi.

## Key Design Decisions
- Sistem kapsamı: çok oturumlu genel assistant memory’si; kişisel ürün UX’i, ajan orkestrasyonu ve ağır fine-tuning ilk sürüme dahil değil.
- Memory üç katmanlı olacak:
  - `episodic store`: ham oturum parçaları ve olay izleri.
  - `fact store`: çıkarılmış yapılandırılmış bilgiler.
  - `version/conflict layer`: her bilginin `current`, `superseded`, `conflicting`, `uncertain` durumunu izleyen katman.
- Varsayılan memory kaydı alanları: `memory_id`, `session_id`, `timestamp`, `entity`, `attribute`, `value`, `evidence_ref`, `confidence`, `status`, `supersedes`.
- Retrieval çıktısı tek chunk olmayacak; `evidence bundle` dönecek: destekleyici kayıtlar + zaman ağırlığı + conflict flag + answerability signal.
- Yanıt politikası: destek yeterli ve tutarlıysa cevap ver; çelişki veya zayıf kanıt varsa `abstain` ya da belirsizlik belirt.
- Baseline’lar:
  - full-history prompting,
  - vanilla vector RAG,
  - summary-based memory,
  - yapılandırılmış fact memory ama temporal/conflict mantığı olmayan sürüm.
- Model stratejisi: 1 açık kaynak instruct model + 1 API model; embedding/vector tarafında mümkün olduğunca mevcut altyapın yeniden kullanılacak.

## Experiment Plan
- Ana benchmark: `LongMemEval`.
- Dış doğrulama: `LoCoMo` üzerinde çok oturumlu recall ve temporal reasoning odaklı alt kurulum.
- Özgün katkı: küçük bir sentetik ek set ile şu durumları enjekte etmek:
  - bilgi güncellemesi,
  - açık çelişki,
  - örtük/dağınık kanıt,
  - belirsiz zaman referansı,
  - cevapsız kalması gereken örnekler.
- Ana metrikler:
  - QA accuracy,
  - temporal update accuracy,
  - conflict-detection F1,
  - abstention precision/recall,
  - unsupported answer rate,
  - basit recall kaybı/kazancı.
- Zorunlu ablation’lar:
  - version/conflict layer kapalı,
  - time-aware retrieval kapalı,
  - evidence bundle yerine nearest-chunk retrieval,
  - abstention policy kapalı.
- Kabul kriteri:
  - vanilla chunk-RAG’a göre temporal/conflict görevlerinde net iyileşme,
  - conflict-heavy örneklerde unsupported answer oranında düşüş,
  - basit factual recall’da anlamlı gerileme olmaması,
  - aynı eğilimin iki backbone modelde de görünmesi.

## Assumptions And Defaults
- İlk resmi çıktı İngilizce paper/report olacak; plan notları Türkçe hazırlanabilir.
- İlk versiyon mevcut public benchmark + küçük özgün sentetik ek ile ilerleyecek; sıfırdan büyük benchmark kurulmayacak.
- Hesaplama bütçesi düşük-orta kabul edildiği için büyük ölçekli fine-tuning ve milyon-token deneyler ilk aşamada yok.
- `EverMemBench` gibi daha ağır, çok-partili senaryolar ilk sürümde ana benchmark değil; iyi ilk sonuç gelirse follow-up olarak ele alınacak.

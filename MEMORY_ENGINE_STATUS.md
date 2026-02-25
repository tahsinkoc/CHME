# CHME MemoryEngine Durum ve Kullanım Raporu

## 1) Şu an uygulama ne durumda?

Sistem şu anda **çalışır ve uçtan uca doğrulanmış** durumda.

- `verify` testi geçiyor (`All tests passed`)
- `test:ollama:dry` testi geçiyor
- `test:ollama` ile canlı Ollama çağrısı (qwen2.5:7b) başarılı

Mevcut mimari artık **MemoryEngine merkezli**:

- Collection yönetimi
- Otomatik ingest + routing
- Retrieval
- Prompt üretimi
- LLM çağrısı

tek yerden (`MemoryEngine`) orkestre ediliyor.

---

## 2) Sistem ne yapıyor?

Sistem bir **RAG tarzı memory pipeline** çalıştırıyor:

1. Markdown dokümanlarını alır (`.md`)
2. Section/chunk ağaç yapısına dönüştürür
3. Keyword index üretir
4. Soruya göre doğru collection(ları) route eder
5. Chunk retrieval yapar
6. Context + question prompt üretir
7. LLM’e gönderip cevap döner

---

## 3) Şu an neleri yapabiliyor?

### Core kabiliyetler

- Çoklu collection desteği
- Otomatik collection oluşturma (`ingestAuto`)
- Deterministik dosya->collection routing
- Rule-based routing (priority destekli)
- Global ask (`ask(question, options)`)
- Scoped ask (`ask(collectionId, question)`)
- Top-N collection seçimi (`routeCollections`)
- Section-aware retrieval
- Context limitiyle prompt üretimi (`maxContextChars`)
- Local/OpenAI LLM provider yönetimi

### LLM tarafı

- Local varsayılan (`provider: local`)
- Ollama endpoint desteği (`LOCAL_LLM_URL`)
- Model seçimi (`qwen2.5:7b`, vb.)
- OpenAI uyumlu endpoint desteği

---

## 4) Nasıl yapabiliyor? (Teknik akış)

### Ingest akışı

1. `ingestAuto(rootPath)` markdown dosyalarını recursive tarar
2. Her dosya için route kararı verir:
   - önce `RoutingRule`
   - sonra path tabanlı slug
   - olmazsa `defaultCollectionId`
3. Collection yoksa otomatik açar
4. `ingestFiles(...)` ile dosyaları ilgili collection’a işler
5. Node tree + keyword index oluşur

### Soru akışı

1. `ask(question)` global route çalıştırır
2. `routeCollections` ile Top-N collection seçer
3. Her collection’da retrieval yapılır
4. Collection + section bilgili context blokları birleştirilir
5. Prompt LLM’e gider ve sadece cevap metni döner

---

## 5) Hangi alana kolaylık sağlıyor?

Bu yapı özellikle şu alanlarda faydalı:

- İç dokümantasyon arama ve soru-cevap
- Operasyon/handbook/FAQ bilgi tabanları
- Ürün notları, release checklist, runbook arşivleri
- Çok klasörlü knowledge base yönetimi

Özellikle çok dosyalı projede önce collection route edip sonra retrieval yapmak,
tek büyük index’e göre daha yönetilebilir ve daha ölçeklenebilir bir akış sağlıyor.

---

## 6) İstediğimiz gibi kolay implement ve kullanım var mı?

Evet, mevcut durumda **kullanım eşiği düşük**:

- Tek entrypoint: `MemoryEngine`
- Auto ingest: kullanıcı klasör verir, sistem dağıtır
- Global ask: collectionId vermeden soru sorulur
- Gerekirse scoped ask ile belirli collection hedeflenir

### Hızlı kullanım örneği

```ts
import { MemoryEngine } from './src/MemoryEngine'

const engine = new MemoryEngine({
  provider: 'local',
  localUrl: 'http://localhost:11434/api/generate',
  model: 'qwen2.5:7b',
  temperature: 0
})

await engine.ingestAuto('./test', { defaultCollectionId: 'general' })
const answer = await engine.ask('What is the main topic of the files?')
console.log(answer)
```

---

## 7) Developer Experience (DX) değerlendirmesi

### Güçlü taraflar

- API sade ve merkezileşmiş
- Test komutları net:
  - `npm run verify`
  - `npm run test:ollama:dry`
  - `npm run test:ollama`
- Deterministik davranış (temperature=0) korunuyor
- Debug edilebilir routing raporu var (`getRoutingReport`)

### Dikkat edilmesi gerekenler

- Global context birleşimi şu an temel seviyede; gelişmiş reranking yok
- Retrieval keyword tabanlı (embedding/semantic yok)
- Çok büyük corpus’ta latency için ileri optimizasyon gerekebilir

---

## 8) Özet karar

Sistem şu an:

- **Çalışıyor**
- **Kullanılabilir**
- **Geliştirilebilir bir temel sunuyor**
- **MemoryEngine merkezli kullanım hedefiyle uyumlu**

Yani mevcut hedef için pratik ve sürdürülebilir bir sürümdeyiz.

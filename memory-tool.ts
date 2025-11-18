// src/tools/memory-tool.ts
// Long-term memory tool: Vectorize + D1 metadata + Gemini embeddings
// Requires: VectorizeClient (env.VECTOR_INDEX), D1Manager (optional), GeminiClient (embedText/embedBatch)

import type { Tool, ToolResult } from './types'; // path adapt if needed
import { VectorizeClient } from '../storage/vectorize-client';
import type D1Manager from '../storage/d1-manager';
import type { GeminiClient } from '../gemini';

// worker-safe unique id generator (no external dependency)
function uniqueId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export class MemoryTool implements Tool {
  name = 'memory';
  private vec: VectorizeClient;
  private d1?: D1Manager;
  private gemini?: GeminiClient;
  private embedDim = 768;

  constructor(vectorBinding: any, d1?: D1Manager, gemini?: GeminiClient) {
    this.vec = new VectorizeClient(vectorBinding);
    this.d1 = d1;
    this.gemini = gemini;
    if (!this.vec) console.warn('[MemoryTool] No Vectorize binding provided');
    if (!this.gemini) console.warn('[MemoryTool] No Gemini client provided — embeddings unavailable');
  }

  // Tool interface: execute(args, state) => ToolResult
  async execute(args: any, state: any): Promise<ToolResult> {
    const action = String(args?.action ?? 'search');

    try {
      switch (action) {
        // -------------------------------------------------------
        // search: embed query, query vector index, enrich with D1 meta
        // args: { query: string, topK?: number, filter?: any }
        // -------------------------------------------------------
        case 'search': {
          const q = String(args.query ?? '');
          if (!q) return { name: 'memory.search', success: true, result: [] };

          if (!this.gemini) throw new Error('Gemini client not configured for memory.search');

          const topK = Number(args.topK ?? 6);
          const qVec = await this.gemini.embedText(q, { normalize: true });
          const raw = await this.vec.query(qVec, { topK, filter: args.filter ?? {} });

          // enrich from D1 if available
          const detailed: any[] = [];
          if (this.d1 && raw.length > 0) {
            const ids = raw.map((r: any) => r.metadata?.source_id ?? r.id).filter(Boolean);
            const rows = await this.d1.getBySourceIds(ids);
            for (const r of raw) {
              const sid = r.metadata?.source_id ?? r.id;
              const metaRow = rows.find((x: any) => x.source_id === sid) ?? null;
              detailed.push({ ...r, source: metaRow });
            }
          } else {
            for (const r of raw) detailed.push(r);
          }

          return { name: 'memory.search', success: true, result: detailed };
        }

        // -------------------------------------------------------
        // store-fragment: store single message fragment
        // args: { text, conversationId?, metadata? }
        // -------------------------------------------------------
        case 'store-fragment': {
          const text = String(args.text ?? '').trim();
          if (!text) return { name: 'memory.storeFragment', success: false, result: 'empty text' };

          if (!this.gemini) throw new Error('Gemini client not configured for memory.store-fragment');

          const convo = args.conversationId ?? null;
          const metadata = args.metadata ?? {};
          const id = uniqueId('frag-');

          // embed single
          const emb = await this.gemini.embedText(text, { normalize: true });

          // insert into vector store
          await this.vec.insert([{
            id,
            values: emb,
            metadata: {
              conversation_id: convo,
              source_type: 'fragment',
              source_id: id,
              preview: text.slice(0, 1024),
              ...metadata
            }
          }]);

          // persist meta to D1 for idempotency/search
          if (this.d1) {
            try {
              await this.d1.insertEmbeddingMeta({
                id,
                conversation_id: convo,
                source_type: 'fragment',
                source_id: id,
                dims: emb.length,
                status: 'ok',
                created_at: Date.now()
              });
            } catch (e) {
              console.warn('[MemoryTool] insertEmbeddingMeta failed', e);
            }
          }

          return { name: 'memory.storeFragment', success: true, result: id };
        }

        // -------------------------------------------------------
        // store-solution: store model-produced solution
        // args: { text, conversationId?, metadata? }
        // -------------------------------------------------------
        case 'store-solution': {
          const text = String(args.text ?? '').trim();
          if (!text) return { name: 'memory.storeSolution', success: false, result: 'empty text' };

          if (!this.gemini) throw new Error('Gemini client not configured for memory.store-solution');

          const convo = args.conversationId ?? null;
          const metadata = args.metadata ?? {};
          const id = uniqueId('sol-');

          const emb = await this.gemini.embedText(text, { normalize: true });

          await this.vec.insert([{
            id,
            values: emb,
            metadata: {
              conversation_id: convo,
              source_type: 'solution',
              source_id: id,
              preview: text.slice(0, 1024),
              ...metadata
            }
          }]);

          if (this.d1) {
            try {
              await this.d1.insertEmbeddingMeta({
                id,
                conversation_id: convo,
                source_type: 'solution',
                source_id: id,
                dims: emb.length,
                status: 'ok',
                created_at: Date.now()
              });
            } catch (e) {
              console.warn('[MemoryTool] insertEmbeddingMeta failed', e);
            }
          }

          return { name: 'memory.storeSolution', success: true, result: id };
        }

        // -------------------------------------------------------
        // store-fragments: batch ingest many fragments (recommended)
        // args: { fragments: [{ text, conversationId?, metadata? }] }
        // -------------------------------------------------------
        case 'store-fragments': {
          const frags = Array.isArray(args.fragments) ? args.fragments : [];
          if (frags.length === 0) return { name: 'memory.storeFragments', success: false, result: 'no fragments' };
          if (!this.gemini) throw new Error('Gemini client not configured for memory.store-fragments');

          // prepare arrays
          const texts: string[] = [];
          const ids: string[] = [];
          const metas: any[] = [];
          for (const f of frags) {
            const t = String(f.text ?? '').trim();
            if (!t) continue;
            const id = uniqueId('frag-');
            texts.push(t);
            ids.push(id);
            metas.push({ conversation_id: f.conversationId ?? null, metadata: f.metadata ?? {} });
          }
          if (texts.length === 0) return { name: 'memory.storeFragments', success: false, result: 'no valid fragments' };

          // batch embed -> embedBatch handles internal batching (recommended default batch size 16)
          const embList = await this.gemini.embedBatch(texts, { normalize: true, batchSize: 16 });

          const inserts = embList.map((vec, i) => ({
            id: ids[i],
            values: vec,
            metadata: {
              conversation_id: metas[i].conversation_id,
              source_type: 'fragment',
              source_id: ids[i],
              preview: texts[i].slice(0, 1024),
              ...metas[i].metadata
            }
          }));

          await this.vec.insert(inserts);

          if (this.d1) {
            try {
              for (let i = 0; i < ids.length; i++) {
                await this.d1.insertEmbeddingMeta({
                  id: ids[i],
                  conversation_id: metas[i].conversation_id,
                  source_type: 'fragment',
                  source_id: ids[i],
                  dims: inserts[i].values.length,
                  status: 'ok',
                  created_at: Date.now()
                });
              }
            } catch (e) {
              console.warn('[MemoryTool] insertEmbeddingMeta batch failed', e);
            }
          }

          return { name: 'memory.storeFragments', success: true, result: { count: inserts.length, ids } };
        }

        // -------------------------------------------------------
        // summarize-topic: produce a short summary (LLM) and store it
        // args: { texts: string[], conversationId?, level?, sources? }
        // -------------------------------------------------------
        case 'summarize-topic': {
          const texts: string[] = Array.isArray(args.texts) ? args.texts : [];
          if (texts.length === 0) return { name: 'memory.summarizeTopic', success: false, result: 'no texts provided' };
          if (!this.gemini) throw new Error('Gemini client not configured for summarize-topic');

          const prompt = `Create a concise, structured summary (facts, decisions, actions) for these messages:\n\n${texts.join('\n\n')}\n\nProvide bulleted facts, decisions, and actions.`;
          // create a short convo for generation (no tools needed)
          const convo = [{ role: 'user', content: prompt }];

          // generate
          const gen = await this.gemini.generateWithTools(convo, [], { stream: false });
          const summary = (gen?.text ?? '').trim();
          if (!summary) return { name: 'memory.summarizeTopic', success: false, result: 'empty summary' };

          // embed summary & persist
          const id = uniqueId('summary-');
          const emb = await this.gemini.embedText(summary, { normalize: true });

          await this.vec.insert([{
            id,
            values: emb,
            metadata: {
              source_type: 'summary',
              conversation_id: args.conversationId ?? null,
              source_id: id,
              preview: summary.slice(0, 1024)
            }
          }]);

          if (this.d1) {
            try {
              await this.d1.insertSummary({
                id,
                conversation_id: args.conversationId ?? null,
                level: Number(args.level ?? 1),
                text: summary,
                created_at: Date.now(),
                sources: args.sources ?? []
              });
              await this.d1.insertEmbeddingMeta({
                id,
                conversation_id: args.conversationId ?? null,
                source_type: 'summary',
                source_id: id,
                dims: emb.length,
                status: 'ok',
                created_at: Date.now()
              });
            } catch (e) {
              console.warn('[MemoryTool] insertSummary/insertEmbeddingMeta failed', e);
            }
          }

          return { name: 'memory.summarizeTopic', success: true, result: { id, summary } };
        }

        // -------------------------------------------------------
        // update-profile: save small settings via D1
        // args: { key, value }
        // -------------------------------------------------------
        case 'update-profile': {
          if (!this.d1) return { name: 'memory.updateProfile', success: false, result: 'D1 not configured' };
          try {
            await this.d1.saveUserSettings({ preferences: { [String(args.key)]: args.value } });
            return { name: 'memory.updateProfile', success: true, result: 'ok' };
          } catch (e) {
            return { name: 'memory.updateProfile', success: false, result: String(e) };
          }
        }

        default:
          return { name: 'memory.unknown', success: false, result: `Unknown action ${action}` };
      }
    } catch (err: any) {
      return { name: `memory.${action}`, success: false, result: String(err?.message ?? err) };
    }
  }
}

export default MemoryTool;

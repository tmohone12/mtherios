<script lang="ts">
  import { canonicalLayoutValue,type CanonicalTypeDefinition } from '$lib/contracts/canonicalTypes';
  let {definition,record}:{definition:CanonicalTypeDefinition;record:Record<string,unknown>}=$props();
  function display(value:unknown){return value===undefined||value===null?'—':typeof value==='string'?value:JSON.stringify(value,null,2);}
</script>
<section aria-label="Canonical layout preview" class="preview">
  {#if !definition.layout.length}<p>No fields selected for this layout.</p>{/if}
  {#each definition.layout as section}<h4>{section.title}</h4>{#each section.fields as field}<dl><dt>{field.label}</dt><dd>{display(canonicalLayoutValue(record,field.path))}</dd></dl>{/each}{/each}
</section>
<style>.preview{padding:1rem;margin:1rem 0;border:1px solid var(--border-primary);border-radius:.4rem}h4{margin:.6rem 0}dl{padding:.5rem 0;border-bottom:1px solid var(--border-secondary)}dt,p{font-size:.8rem;color:var(--text-secondary)}dd{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;margin:.3rem 0}</style>

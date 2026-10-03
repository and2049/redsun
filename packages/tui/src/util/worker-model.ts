// REDSUN: worker-model references as the worker-model RPC stores them: providerID/modelID[#variant].
export function workerModelRef(model: { providerID: string; modelID: string; variant?: string }) {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

export function parseWorkerModelRef(value: string) {
  const slash = value.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = value.slice(0, slash)
  const rest = value.slice(slash + 1)
  const hash = rest.lastIndexOf("#")
  const modelID = hash > 0 ? rest.slice(0, hash) : rest
  const variant = hash > 0 ? rest.slice(hash + 1) : undefined
  if (modelID.length === 0) return undefined
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

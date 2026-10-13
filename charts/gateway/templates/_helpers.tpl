{{- define "gw.labels" -}}
app.kubernetes.io/part-of: switchboard
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "gw.host" -}}
{{- regexReplaceAll "^https?://([^/:]+).*$" .Values.publicUrl "${1}" -}}
{{- end }}

{{- define "gw.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* Provisioning settings shared by the gateway API (limits, validation) and the provisioner. */}}
{{- define "gw.provisioningEnv" -}}
- { name: PROVISIONING_ENABLED, value: {{ .Values.provisioner.enabled | quote }} }
- { name: STORE_URL_TEMPLATE, value: {{ .Values.provisioner.storeUrlTemplate | quote }} }
- { name: STORE_NAMESPACE_PREFIX, value: {{ .Values.provisioner.storeNamespacePrefix | quote }} }
- { name: STORE_TIMEOUT_MS, value: {{ .Values.provisioner.storeTimeoutMs | quote }} }
- { name: MAX_STORES_PER_USER, value: {{ .Values.provisioner.maxStoresPerUser | quote }} }
- { name: MAX_STORES_TOTAL, value: {{ .Values.provisioner.maxStoresTotal | quote }} }
- { name: HOSTED_NAMESPACE, value: {{ .Values.provisioner.hostedNamespace | quote }} }
- { name: HOSTED_IMAGE_PREFIXES, value: {{ join "," .Values.provisioner.hostedImagePrefixes | quote }} }
- { name: HOSTED_TIMEOUT_MS, value: {{ .Values.provisioner.hostedTimeoutMs | quote }} }
- { name: MAX_HOSTED_SERVERS, value: {{ .Values.provisioner.maxHostedServers | quote }} }
- { name: GATEWAY_NAMESPACE, value: {{ .Release.Namespace | quote }} }
{{- end }}

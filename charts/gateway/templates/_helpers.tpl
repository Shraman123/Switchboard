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

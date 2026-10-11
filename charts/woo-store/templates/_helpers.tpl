{{- define "store.labels" -}}
app.kubernetes.io/part-of: switchboard
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "store.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "store.host" -}}
{{- regexReplaceAll "^https?://([^/:]+).*$" .Values.siteUrl "${1}" -}}
{{- end }}

{{- define "store.podSecurity" -}}
runAsNonRoot: true
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "store.containerSecurity" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* Environment shared by the web pod and the bootstrap job (wp-config.php reads it at runtime). */}}
{{- define "store.wpEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ .Release.Name }}-db
- name: WORDPRESS_DB_NAME
  value: wordpress
- name: WORDPRESS_DB_USER
  value: wordpress
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.credentialsSecret }}, key: db-password }
# One random value in the Secret, expanded into WordPress's eight keys/salts.
- name: WP_SALT
  valueFrom:
    secretKeyRef: { name: {{ .Values.credentialsSecret }}, key: wp-salt }
- name: WORDPRESS_AUTH_KEY
  value: "$(WP_SALT)-auth_key"
- name: WORDPRESS_SECURE_AUTH_KEY
  value: "$(WP_SALT)-secure_auth_key"
- name: WORDPRESS_LOGGED_IN_KEY
  value: "$(WP_SALT)-logged_in_key"
- name: WORDPRESS_NONCE_KEY
  value: "$(WP_SALT)-nonce_key"
- name: WORDPRESS_AUTH_SALT
  value: "$(WP_SALT)-auth_salt"
- name: WORDPRESS_SECURE_AUTH_SALT
  value: "$(WP_SALT)-secure_auth_salt"
- name: WORDPRESS_LOGGED_IN_SALT
  value: "$(WP_SALT)-logged_in_salt"
- name: WORDPRESS_NONCE_SALT
  value: "$(WP_SALT)-nonce_salt"
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HTTP_BLOCK_EXTERNAL', true);
    define('AUTOMATIC_UPDATER_DISABLED', true);
    define('DISALLOW_FILE_MODS', false);
{{- end }}

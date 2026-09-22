#!/bin/sh
set -e

generate_cors_config() {
	ORIGINS="${PIXMAP_ALLOWED_ORIGINS:-https://pixmap.fun,https://dev.pixmap.fun,http://localhost:5001,http://127.0.0.1:5001}"
	OUT=/etc/nginx/conf.d/cors-origins.conf

	{
		echo 'map $http_origin $cors_origin {'
		echo '    default "";'
		echo '    "" "";'
		OLDIFS=$IFS
		IFS=,
		for o in $ORIGINS; do
			o=$(echo "$o" | tr -d '[:space:]')
			[ -n "$o" ] || continue
			printf '    "%s" $http_origin;\n' "$o"
		done
		IFS=$OLDIFS
		echo '}'

		echo ''
	} > "$OUT"
}

resolve_ssl_certs() {
	SSL_DIR=/etc/nginx/ssl
	mkdir -p "$SSL_DIR"

	if [ -f "$SSL_DIR/fullchain.pem" ] && [ -f "$SSL_DIR/privkey.pem" ]; then
		return 0
	fi

	# Common filenames from Cloudflare / legacy host nginx setups.
	for cert in origin.pem cloudflare.pem cert.pem certificate.pem; do
		for key in origin.key cloudflare.key key.pem private.key privkey.pem; do
			if [ -f "$SSL_DIR/$cert" ] && [ -f "$SSL_DIR/$key" ]; then
				ln -sf "$cert" "$SSL_DIR/fullchain.pem"
				ln -sf "$key" "$SSL_DIR/privkey.pem"
				echo "nginx: using $SSL_DIR/$cert + $SSL_DIR/$key" >&2
				return 0
			fi
		done
	done

	return 1
}

generate_cors_config

SSL_DIR=/etc/nginx/ssl

if ! resolve_ssl_certs; then
	echo "nginx: missing origin certs in $SSL_DIR" >&2
	echo "  contents of mount:" >&2
	ls -la "$SSL_DIR" 2>&1 | sed 's/^/    /' >&2
	echo "  prod: put fullchain.pem + privkey.pem on the HOST, then in .env:" >&2
	echo "    PIXMAP_SSL_CERT_DIR=/etc/nginx/ssl" >&2
	echo "  (without that line docker mounts empty ./deploy/ssl instead)" >&2
	echo "  local: set PIXMAP_DEV_SSL=1 in .env" >&2
	if [ "${PIXMAP_DEV_SSL:-0}" != "1" ]; then
		exit 1
	fi
	echo "nginx: generating local self-signed certs (PIXMAP_DEV_SSL=1)" >&2
	openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
		-keyout "$SSL_DIR/privkey.pem" \
		-out "$SSL_DIR/fullchain.pem" \
		-subj '/CN=pixmap-local'
fi

echo "nginx: SSL OK ($(openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -subject 2>/dev/null || echo unknown))" >&2

exec nginx -g 'daemon off;'

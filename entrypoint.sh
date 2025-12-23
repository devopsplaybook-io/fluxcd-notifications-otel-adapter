#!/bin/sh

if [ "${APPLICATION_TITLE}" == "" ]; then
  APPLICATION_TITLE="Kubernetes Web"
fi

sed -i "s/APPLICATION_TITLE/$APPLICATION_TITLE/g" /opt/app/fluxcd-notifications-otel-adapter/web/manifest.webmanifest

node dist/App.js
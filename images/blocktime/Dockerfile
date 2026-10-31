FROM python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8

COPY server.py /app/server.py
COPY web /web

ENV PORT=8080 \
    WEB_DIR=/web \
    SETTINGS_FILE=/data/settings.json

USER 1000:1000
EXPOSE 8080
CMD ["python", "-I", "/app/server.py"]

# syntax=docker/dockerfile:1
# VX Design engineering worker — G0 capability audit image.
# KiCad 10 (kicad-cli + pcbnew Python API + symbol/footprint libraries + ngspice)
# plus KiKit, Freerouting (needs Java 25+), CadQuery, SKiDL, kicad-python and atopile.
FROM kicad/kicad:10.0.8

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-pip python3-venv openjdk-25-jre-headless curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Main tool venv. --system-site-packages exposes KiCad's pcbnew module.
ENV VX_VENV=/opt/vx/venv
# Optional extra CA (e.g. a TLS-intercepting corporate proxy) is passed as a build
# secret so it is never stored in the image: --secret id=extra_ca,src=<bundle.crt>
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi \
 && python3 -m venv --system-site-packages $VX_VENV \
 && $VX_VENV/bin/pip install --no-cache-dir \
      kikit==1.8.1 \
      cadquery==2.8.0 \
      shapely==2.2.0 \
      skidl==3.0.0 \
      kicad-python==0.8.0

# atopile pins many dependencies; keep it isolated.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi \
 && python3 -m venv /opt/vx/atopile \
 && /opt/vx/atopile/bin/pip install --no-cache-dir atopile==0.12.6 \
 && ln -s /opt/vx/atopile/bin/ato /usr/local/bin/ato

# Freerouting from Maven Central, checksum-verified.
ARG FREEROUTING_VERSION=2.5.0
ARG FREEROUTING_SHA1=a9133705bd3f589ddcaa2acce4dbcfd2cd8ac640
RUN --mount=type=secret,id=extra_ca,required=false \
    CA=""; if [ -f /run/secrets/extra_ca ]; then CA="--cacert /run/secrets/extra_ca"; fi \
 && curl -fsSL $CA -o /opt/vx/freerouting.jar \
      https://repo1.maven.org/maven2/app/freerouting/freerouting/${FREEROUTING_VERSION}/freerouting-${FREEROUTING_VERSION}-executable.jar \
 && echo "${FREEROUTING_SHA1}  /opt/vx/freerouting.jar" | sha1sum -c -

ENV PATH=$VX_VENV/bin:$PATH \
    FREEROUTING_JAR=/opt/vx/freerouting.jar \
    FREEROUTING_VERSION=${FREEROUTING_VERSION} \
    KICAD_SYMBOL_DIR=/usr/share/kicad/symbols \
    KICAD_FOOTPRINT_DIR=/usr/share/kicad/footprints \
    KICAD10_SYMBOL_DIR=/usr/share/kicad/symbols \
    KICAD10_FOOTPRINT_DIR=/usr/share/kicad/footprints

COPY g0 /opt/vx/g0
WORKDIR /work
RUN chown kicad:kicad /work
USER kicad

# Writes results to /out (mount a host directory there).
ENTRYPOINT ["python3", "/opt/vx/g0/run.py"]
CMD ["--out", "/out"]

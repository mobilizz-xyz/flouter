FROM python:3.12-slim
RUN pip install --no-cache-dir deface onnxruntime opencv-python-headless imageio-ffmpeg \
 && pip uninstall -y opencv-python 2>/dev/null; pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless
RUN useradd -u 1000 -m app
USER app
WORKDIR /app
COPY server.py /app/server.py
CMD ["python", "-u", "/app/server.py"]

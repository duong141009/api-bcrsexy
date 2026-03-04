# Sử dụng Node.js bản mới nhất làm base
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Chuyển sang quyền root
USER root

# Thiết lập thư mục làm việc
WORKDIR /app

# Biến môi trường để Puppeteer KHÔNG tải lại Chrome (đã có sẵn trong base image)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

# Sao chép package.json và cài đặt thư viện
COPY package*.json ./
RUN npm install

# Sao chép toàn bộ mã nguồn vào container
COPY . .

# Mở port cho server
EXPOSE 5000

# Lệnh chạy ứng dụng
CMD ["node", "poll.js"]

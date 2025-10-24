// Interactive Mandelbrot Set Explorer
// GPU-accelerated with WebGL fallback to CPU rendering

class MandelbrotExplorer {
    constructor() {
        this.canvas = document.getElementById('canvas');
        this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
        
        this.loading = document.getElementById('loading');
        this.instructions = document.getElementById('instructions');
        
        if (!this.gl) {
            console.warn('WebGL not supported, falling back to CPU rendering');
            this.ctx = this.canvas.getContext('2d');
            this.useWebGL = false;
        } else {
            this.useWebGL = true;
            this.setupWebGL();
        }
        
        // Always initialize 2D context as fallback
        if (!this.ctx) {
            this.ctx = this.canvas.getContext('2d');
        }
        
        // View parameters
        this.centerX = -0.5;
        this.centerY = 0;
        this.zoom = 0.5;
        this.colorScheme = 0;
        this.smoothing = true;
        this.antialiasing = false;
        this.adaptiveIterations = true;
        
        // Quality settings
        this.qualitySettings = {
            fast: { iterations: 200, scale: 1.0, name: 'Fast' },
            medium: { iterations: 500, scale: 1.0, name: 'Medium' },
            high: { iterations: 1000, scale: 1.0, name: 'High' },
            ultra: { iterations: 2000, scale: 1.0, name: 'Ultra' }
        };
        this.currentQuality = 'ultra';
        
        // Performance detection
        this.performanceLevel = this.detectPerformance();
        this.maxIterations = this.performanceLevel.maxIterations;
        this.adaptiveQuality = true;
        
        // Interaction state
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.isRendering = false;
        
        // Web Workers for CPU rendering
        this.numWorkers = navigator.hardwareConcurrency || 4;
        this.workers = [];
        this.initWorkers();
        
        this.init();
    }
    
    detectPerformance() {
        const cores = navigator.hardwareConcurrency || 4;
        const memory = navigator.deviceMemory || 4;
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        
        let performanceLevel = 'medium';
        let maxIterations = 2000;
        
        if (cores >= 8 && memory >= 8) {
            performanceLevel = 'ultra';
            maxIterations = 8000;
        } else if (cores >= 6 && memory >= 6) {
            performanceLevel = 'high';
            maxIterations = 4000;
        } else if (cores >= 4 && memory >= 4) {
            performanceLevel = 'medium';
            maxIterations = 2000;
        } else {
            performanceLevel = 'low';
            maxIterations = 1000;
        }
        
        console.log(`Performance detected: ${performanceLevel} (${cores} cores, ${memory}GB RAM, max ${maxIterations} iterations)`);
        
        return {
            level: performanceLevel,
            maxIterations: maxIterations,
            cores: cores,
            memory: memory
        };
    }
    
    initWorkers() {
        for (let i = 0; i < this.numWorkers; i++) {
            this.workers.push(new Worker('mandelbrot-worker.js'));
        }
    }
    
    setupWebGL() {
        // Vertex shader
        const vertexShaderSource = `
            attribute vec2 position;
            varying vec2 v_texCoord;
            
            void main() {
                gl_Position = vec4(position, 0.0, 1.0);
                v_texCoord = (position + 1.0) * 0.5;
            }
        `;
        
        // Fragment shader with optimizations
        const fragmentShaderSource = `
            precision highp float;
            uniform vec2 u_resolution;
            uniform vec2 u_center;
            uniform float u_zoom;
            uniform int u_iterations;
            uniform int u_colorScheme;
            uniform bool u_smoothing;
            uniform float u_time;
            varying vec2 v_texCoord;
            
            const float ESCAPE_RADIUS = 256.0;
            const float LOG_2 = 0.6931471805599453;
            
            vec2 complexSquare(vec2 z) {
                return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
            }
            
            float getSmoothIteration(vec2 z, int iterations) {
                if (!u_smoothing) {
                    return float(iterations);
                }
                
                float modulus = length(z);
                if (modulus > 1.0) {
                    float nu = log(log(modulus)) / log(2.0);
                    return float(iterations) + 1.0 - nu;
                }
                return float(iterations);
            }
            
            vec3 getClassicColor(float t) {
                vec3 a = vec3(0.5, 0.5, 0.5);
                vec3 b = vec3(0.5, 0.5, 0.5);
                vec3 c = vec3(1.0, 1.0, 1.0);
                vec3 d = vec3(0.0, 0.10, 0.20);
                return a + b * cos(6.28318 * (c * t + d));
            }
            
            vec3 getFireColor(float t) {
                t = mod(t * 3.0, 1.0);
                if (t < 0.33) {
                    return mix(vec3(0.0, 0.0, 0.0), vec3(0.8, 0.0, 0.0), t * 3.0);
                } else if (t < 0.66) {
                    return mix(vec3(0.8, 0.0, 0.0), vec3(1.0, 0.8, 0.0), (t - 0.33) * 3.0);
                } else {
                    return mix(vec3(1.0, 0.8, 0.0), vec3(1.0, 1.0, 0.8), (t - 0.66) * 3.0);
                }
            }
            
            vec3 getOceanColor(float t) {
                return mix(
                    vec3(0.0, 0.07, 0.15),
                    vec3(0.0, 0.5, 0.8),
                    smoothstep(0.0, 1.0, t)
                ) + vec3(0.0, 0.2, 0.3) * cos(t * 12.56);
            }
            
            vec3 getPsychedelicColor(float t) {
                return 0.5 + 0.5 * cos(6.28318 * (t * 3.0 + vec3(0.0, 0.33, 0.67)));
            }
            
            vec3 getMonochromeColor(float t) {
                return vec3(smoothstep(0.0, 1.0, t));
            }
            
            vec3 getUltraSmoothColor(float t) {
                vec3 color = vec3(0.0);
                float freq = 1.0;
                float amp = 1.0;
                
                for (int i = 0; i < 4; i++) {
                    vec3 a = vec3(0.5, 0.5, 0.5);
                    vec3 b = vec3(0.5, 0.5, 0.5);
                    vec3 c = vec3(1.0, 1.0, 1.5);
                    vec3 d = vec3(0.0, 0.1, 0.2) + float(i) * 0.1;
                    
                    color += amp * (a + b * cos(6.28318 * freq * (c * t + d)));
                    
                    freq *= 2.0;
                    amp *= 0.5;
                }
                
                return color;
            }
            
            vec3 getColor(float t) {
                if (u_colorScheme == 0) return getClassicColor(t);
                else if (u_colorScheme == 1) return getFireColor(t);
                else if (u_colorScheme == 2) return getOceanColor(t);
                else if (u_colorScheme == 3) return getPsychedelicColor(t);
                else if (u_colorScheme == 4) return getMonochromeColor(t);
                else return getUltraSmoothColor(t);
            }
            
            vec4 mandelbrot(vec2 c) {
                vec2 z = vec2(0.0);
                int iterations = 0;
                
                // Cardioid and period-2 bulb optimization
                float q = (c.x - 0.25) * (c.x - 0.25) + c.y * c.y;
                if (q * (q + (c.x - 0.25)) <= 0.25 * c.y * c.y) {
                    return vec4(0.0, 0.0, 0.0, 1.0);
                }
                
                if ((c.x + 1.0) * (c.x + 1.0) + c.y * c.y <= 0.0625) {
                    return vec4(0.0, 0.0, 0.0, 1.0);
                }
                
                // Main iteration loop
                for (int i = 0; i < 8000; i++) {
                    z = complexSquare(z) + c;
                    
                    float dot_zz = dot(z, z);
                    if (dot_zz > ESCAPE_RADIUS * ESCAPE_RADIUS) {
                        iterations = i;
                        break;
                    }
                    
                    iterations = i;
                }
                
                if (iterations >= 7999) {
                    return vec4(0.0, 0.0, 0.0, 1.0);
                }
                
                float normalized = float(iterations) / 8000.0;
                vec3 color = getColor(normalized);
                
                return vec4(color, 1.0);
            }
            
            void main() {
                vec2 aspectRatio = vec2(u_resolution.x / u_resolution.y, 1.0);
                vec2 uv = (v_texCoord - 0.5) * 2.0 * aspectRatio;
                
                vec2 c = u_center + uv / u_zoom;
                
                gl_FragColor = mandelbrot(c);
            }
        `;
        
        this.program = this.createShaderProgram(vertexShaderSource, fragmentShaderSource);
        this.gl.useProgram(this.program);
        
        // Get uniform locations
        this.uniforms = {
            resolution: this.gl.getUniformLocation(this.program, 'u_resolution'),
            center: this.gl.getUniformLocation(this.program, 'u_center'),
            zoom: this.gl.getUniformLocation(this.program, 'u_zoom'),
            iterations: this.gl.getUniformLocation(this.program, 'u_iterations'),
            colorScheme: this.gl.getUniformLocation(this.program, 'u_colorScheme'),
            smoothing: this.gl.getUniformLocation(this.program, 'u_smoothing'),
            time: this.gl.getUniformLocation(this.program, 'u_time')
        };
        
        // Create full-screen quad
        const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
        this.vertexBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
        
        const positionLocation = this.gl.getAttribLocation(this.program, 'position');
        this.gl.enableVertexAttribArray(positionLocation);
        this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, 0, 0);
    }
    
    createShaderProgram(vertexSource, fragmentSource) {
        const vertexShader = this.createShader(this.gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.createShader(this.gl.FRAGMENT_SHADER, fragmentSource);
        
        if (!vertexShader || !fragmentShader) {
            console.error('Failed to create shaders');
            return null;
        }
        
        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);
        
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            console.error('Shader program failed to link:', this.gl.getProgramInfoLog(program));
            return null;
        }
        
        return program;
    }
    
    createShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('Shader compilation failed:', this.gl.getShaderInfoLog(shader));
            this.gl.deleteShader(shader);
            return null;
        }
        
        return shader;
    }
    
    init() {
        this.setupCanvas();
        this.setupEventListeners();
        
        setTimeout(() => {
            this.render();
        }, 100);
        
        this.hideInstructionsAfterDelay();
    }
    
    setupCanvas() {
        const resizeCanvas = () => {
            const quality = this.qualitySettings[this.currentQuality];
            this.canvas.width = window.innerWidth * quality.scale;
            this.canvas.height = window.innerHeight * quality.scale;
            this.canvas.style.width = window.innerWidth + 'px';
            this.canvas.style.height = window.innerHeight + 'px';
            
            if (this.useWebGL && this.gl) {
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            }
            
            this.render();
        };
        
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
    }
    
    setupEventListeners() {
        // Mouse events
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.handleMouseUp());
        this.canvas.addEventListener('mouseleave', () => this.handleMouseUp());
        
        // Wheel events
        this.canvas.addEventListener('wheel', (e) => this.handleWheel(e));
        
        // Touch events
        this.canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e));
        this.canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e));
        this.canvas.addEventListener('touchend', () => this.handleTouchEnd());
        
        // Color scheme buttons
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const scheme = parseInt(e.target.dataset.scheme);
                this.setColorScheme(scheme);
            });
        });
        
        // Control buttons
        document.getElementById('reset-btn').addEventListener('click', () => this.reset());
        document.getElementById('smoothing-btn').addEventListener('click', () => this.toggleSmoothing());
        document.getElementById('antialiasing-btn').addEventListener('click', () => this.toggleAntialiasing());
        document.getElementById('download-btn').addEventListener('click', () => this.download());
        document.getElementById('fullscreen-btn').addEventListener('click', () => this.toggleFullscreen());
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'r':
                case 'R':
                    this.reset();
                    break;
                case 'd':
                case 'D':
                    this.download();
                    break;
                case 'f':
                case 'F':
                    this.toggleFullscreen();
                    break;
                case '1':
                    this.setColorScheme(0);
                    break;
                case '2':
                    this.setColorScheme(1);
                    break;
                case '3':
                    this.setColorScheme(2);
                    break;
                case '4':
                    this.setColorScheme(3);
                    break;
                case '5':
                    this.setColorScheme(4);
                    break;
                case '6':
                    this.setColorScheme(5);
                    break;
                case 's':
                case 'S':
                    this.toggleSmoothing();
                    break;
                case 'a':
                case 'A':
                    this.toggleAntialiasing();
                    break;
            }
        });
    }
    
    handleMouseDown(e) {
        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
    }
    
    handleMouseMove(e) {
        if (this.isDragging) {
            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;
            
            this.centerX -= deltaX / (this.zoom * this.canvas.width / 4);
            this.centerY += deltaY / (this.zoom * this.canvas.height / 4);
            
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            
            this.render();
        }
    }
    
    handleMouseUp() {
        this.isDragging = false;
        this.canvas.style.cursor = 'crosshair';
    }
    
    handleWheel(e) {
        e.preventDefault();
        
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        
        const complexX = (mouseX - this.canvas.width / 2) / (this.zoom * this.canvas.width / 4) + this.centerX;
        const complexY = this.centerY - (mouseY - this.canvas.height / 2) / (this.zoom * this.canvas.height / 4);
        
        this.zoom *= zoomFactor;
        
        this.centerX = complexX - (mouseX - this.canvas.width / 2) / (this.zoom * this.canvas.width / 4);
        this.centerY = complexY + (mouseY - this.canvas.height / 2) / (this.zoom * this.canvas.height / 4);
        
        this.render();
    }
    
    handleTouchStart(e) {
        e.preventDefault();
        if (e.touches.length === 1) {
            this.isDragging = true;
            this.lastMouseX = e.touches[0].clientX;
            this.lastMouseY = e.touches[0].clientY;
        }
    }
    
    handleTouchMove(e) {
        e.preventDefault();
        if (e.touches.length === 1 && this.isDragging) {
            const deltaX = e.touches[0].clientX - this.lastMouseX;
            const deltaY = e.touches[0].clientY - this.lastMouseY;
            
            this.centerX -= deltaX / (this.zoom * this.canvas.width / 4);
            this.centerY += deltaY / (this.zoom * this.canvas.height / 4);
            
            this.lastMouseX = e.touches[0].clientX;
            this.lastMouseY = e.touches[0].clientY;
            
            this.render();
        }
    }
    
    handleTouchEnd() {
        this.isDragging = false;
    }
    
    shouldUseGPU() {
        const maxGPUZoom = 1e14;
        return this.useWebGL && this.zoom < maxGPUZoom;
    }
    
    render() {
        if (this.shouldUseGPU()) {
            this.renderWebGL();
        } else {
            this.renderCPU();
        }
    }
    
    renderWebGL() {
        this.gl.useProgram(this.program);
        
        let iterations = this.qualitySettings[this.currentQuality].iterations;
        if (this.adaptiveQuality) {
            const zoomFactor = Math.max(1, Math.log10(this.zoom));
            iterations = Math.min(this.maxIterations, 
                Math.max(500, Math.floor(500 + zoomFactor * 500)));
        }
        
        // Set uniforms
        this.gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
        this.gl.uniform2f(this.uniforms.center, this.centerX, this.centerY);
        this.gl.uniform1f(this.uniforms.zoom, this.zoom);
        this.gl.uniform1i(this.uniforms.iterations, iterations);
        this.gl.uniform1i(this.uniforms.colorScheme, this.colorScheme);
        this.gl.uniform1i(this.uniforms.smoothing, this.smoothing ? 1 : 0);
        this.gl.uniform1f(this.uniforms.time, performance.now() / 1000);
        
        // Clear and draw
        this.gl.clearColor(0, 0, 0, 1);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        this.updateUI();
    }
    
    async renderCPU() {
        if (this.isRendering) return;
        this.isRendering = true;
        
        this.showLoading();
        
        if (!this.workers || this.workers.length === 0) {
            this.simpleCPURender();
            return;
        }
        
        const startTime = performance.now();
        const width = this.canvas.width;
        const height = this.canvas.height;
        
        let iterations = this.qualitySettings[this.currentQuality].iterations;
        if (this.adaptiveQuality) {
            const zoomFactor = Math.max(1, Math.log10(this.zoom));
            iterations = Math.min(this.maxIterations, 
                Math.max(1000, Math.floor(1000 + zoomFactor * 1000)));
        }
        
        // Prepare worker tasks
        const rowsPerWorker = Math.ceil(height / this.numWorkers);
        const promises = [];
        
        for (let i = 0; i < this.numWorkers; i++) {
            const startY = i * rowsPerWorker;
            const endY = Math.min((i + 1) * rowsPerWorker, height);
            
            if (startY >= height) break;
            
            const promise = new Promise((resolve) => {
                const worker = this.workers[i];
                
                worker.onmessage = (e) => {
                    if (e.data.type === 'progress') {
                        const totalProgress = (i + e.data.progress) / this.numWorkers;
                        document.getElementById('loading-text').textContent = 
                            `Rendering... ${Math.floor(totalProgress * 100)}%`;
                    } else if (e.data.type === 'result') {
                        resolve(e.data);
                    }
                };
                
                worker.postMessage({
                    type: 'calculate',
                    params: {
                        startX: 0,
                        endX: width,
                        startY: startY,
                        endY: endY,
                        width: width,
                        height: height,
                        centerX: this.centerX,
                        centerY: this.centerY,
                        zoom: this.zoom * 200,
                        maxIterations: iterations,
                        colorScheme: this.colorScheme,
                        smoothing: this.smoothing,
                        antialiasing: false
                    }
                });
            });
            
            promises.push(promise);
        }
        
        // Wait for all workers
        const results = await Promise.all(promises);
        
        // Combine results
        const imageData = new ImageData(width, height);
        for (const result of results) {
            const data = result.imageData;
            const startY = result.startY;
            
            for (let y = result.startY; y < result.endY; y++) {
                for (let x = 0; x < width; x++) {
                    const srcIdx = ((y - startY) * width + x) * 4;
                    const dstIdx = (y * width + x) * 4;
                    
                    imageData.data[dstIdx] = data[srcIdx];
                    imageData.data[dstIdx + 1] = data[srcIdx + 1];
                    imageData.data[dstIdx + 2] = data[srcIdx + 2];
                    imageData.data[dstIdx + 3] = data[srcIdx + 3];
                }
            }
        }
        
        // Draw to canvas
        this.ctx.putImageData(imageData, 0, 0);
        
        // Hide progress
        this.hideLoading();
        this.isRendering = false;
        
        const endTime = performance.now();
        console.log('CPU Render complete in:', Math.round(endTime - startTime), 'ms');
        this.updateUI();
    }
    
    simpleCPURender() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        
        // Clear canvas
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, width, height);
        
        // Simple Mandelbrot calculation
        const imageData = this.ctx.createImageData(width, height);
        const data = imageData.data;
        
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const cX = (x - width / 2) / (this.zoom * width / 4) + this.centerX;
                const cY = this.centerY - (y - height / 2) / (this.zoom * height / 4);
                
                let zx = 0, zy = 0;
                let iter = 0;
                
                let maxIter = this.qualitySettings[this.currentQuality].iterations;
                if (this.adaptiveQuality) {
                    const zoomFactor = Math.max(1, Math.log10(this.zoom));
                    maxIter = Math.min(this.maxIterations, 
                        Math.max(500, Math.floor(500 + zoomFactor * 500)));
                }
                
                while (zx * zx + zy * zy < 4 && iter < maxIter) {
                    const tmp = zx * zx - zy * zy + cX;
                    zy = 2 * zx * zy + cY;
                    zx = tmp;
                    iter++;
                }
                
                const idx = (y * width + x) * 4;
                if (iter === maxIter) {
                    data[idx] = 0;
                    data[idx + 1] = 0;
                    data[idx + 2] = 0;
                } else {
                    const t = iter / maxIter;
                    const smoothT = t + (1 - Math.log(Math.log(Math.sqrt(zx * zx + zy * zy))) / Math.log(2)) / maxIter;
                    
                    const r = Math.floor(255 * (0.5 + 0.5 * Math.sin(smoothT * 6.28)));
                    const g = Math.floor(255 * (0.5 + 0.5 * Math.sin(smoothT * 6.28 + 2.09)));
                    const b = Math.floor(255 * (0.5 + 0.5 * Math.sin(smoothT * 6.28 + 4.18)));
                    
                    data[idx] = r;
                    data[idx + 1] = g;
                    data[idx + 2] = b;
                }
                data[idx + 3] = 255;
            }
        }
        
        this.ctx.putImageData(imageData, 0, 0);
        this.hideLoading();
        this.isRendering = false;
        this.updateUI();
    }
    
    setColorScheme(scheme) {
        this.colorScheme = scheme;
        
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-scheme="${scheme}"]`).classList.add('active');
        
        this.render();
    }
    
    toggleSmoothing() {
        this.smoothing = !this.smoothing;
        this.render();
    }
    
    toggleAntialiasing() {
        this.antialiasing = !this.antialiasing;
        this.render();
    }
    
    reset() {
        this.centerX = -0.5;
        this.centerY = 0;
        this.zoom = 0.5;
        this.render();
    }
    
    download() {
        const link = document.createElement('a');
        link.download = `mandelbrot-${Date.now()}.png`;
        link.href = this.canvas.toDataURL();
        link.click();
    }
    
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.log('Error attempting to enable fullscreen:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }
    
    showLoading() {
        this.loading.classList.add('show');
    }
    
    hideLoading() {
        this.loading.classList.remove('show');
    }
    
    updateUI() {
        const zoomValue = this.zoom >= 1 ? `${this.zoom.toFixed(1)}×` : `${(1/this.zoom).toFixed(1)}×`;
        document.getElementById('zoom-value').textContent = zoomValue;
        
        const centerValue = `${this.centerX.toFixed(3)}, ${this.centerY.toFixed(3)}`;
        document.getElementById('center-value').textContent = centerValue;
        
        const qualityName = this.qualitySettings[this.currentQuality].name;
        document.getElementById('quality-value').textContent = qualityName;
        
        // Show rendering mode
        let modeValue = this.shouldUseGPU() ? 'GPU' : 'CPU';
        document.getElementById('mode-value').textContent = modeValue;
        
        // Show current iteration count
        let iterations = this.qualitySettings[this.currentQuality].iterations;
        if (this.adaptiveQuality) {
            const zoomFactor = Math.max(1, Math.log10(this.zoom));
            iterations = Math.min(this.maxIterations, 
                Math.max(500, Math.floor(500 + zoomFactor * 500)));
        }
        document.getElementById('iterations-value').textContent = iterations;
    }
    
    hideInstructionsAfterDelay() {
        setTimeout(() => {
            this.instructions.classList.add('hidden');
        }, 3000);
    }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    new MandelbrotExplorer();
});

// Prevent context menu
document.getElementById('canvas').addEventListener('contextmenu', (e) => {
    e.preventDefault();
});

// Handle fullscreen changes
document.addEventListener('fullscreenchange', () => {
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
    }, 100);
});
